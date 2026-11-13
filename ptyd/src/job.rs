//! A Win32 Job Object per terminal: the shell is assigned to it right after
//! spawn and everything it starts inherits the membership (nested jobs, such as
//! the one libuv gives node's children, sit inside it and are ended with it).
//!
//! Closing a terminal is then one `TerminateJobObject` instead of a `taskkill
//! /T` process walking parent pids, and it reaches processes whose parent has
//! already exited, which a parent-pid walk cannot. `KILL_ON_JOB_CLOSE` means a
//! tree never outlives ptyd either: when ptyd exits, the kernel closes the
//! handle and ends whatever is left.
//!
//! What it does not cover: a process the shell starts in the microseconds
//! between `CreateProcessW` and the assignment (a shell is nowhere near
//! starting anything by then), and a process created with
//! `CREATE_BREAKAWAY_FROM_JOB`, which `BREAKAWAY_OK` lets leave on purpose
//! rather than fail its `CreateProcess`.

use std::io;
use std::os::windows::io::RawHandle;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    JobObjectCpuRateControlInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PRIORITY_CLASS,
};
use windows_sys::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS;

/// The ptyd-wide "agents" job every session job nests inside. It carries the
/// CPU hard cap and the BelowNormal priority class. ptyd itself is never in it.
/// Nesting (Windows 8+): a process may join a second job when that job is a
/// descendant of the ones it is already in. So the order is parent first, then
/// the session job, which becomes the parent's child (the other way round, the
/// parent assignment would fail: a process cannot move up to an ancestor).
static AGENTS: OnceLock<Option<Job>> = OnceLock::new();
static CAP_PCT: OnceLock<Option<u32>> = OnceLock::new();

/// The cap actually in force (percent of the whole machine), None when uncapped.
pub fn effective_cap_pct() -> Option<u32> {
    CAP_PCT.get().copied().flatten()
}

/// Create the agents job once. `cap_pct` None = no CPU cap (the job still sets
/// the priority class). Any failure is logged once and sessions run uncapped.
pub fn init_agents(cap_pct: Option<u32>) {
    AGENTS.get_or_init(|| match build_agents(cap_pct) {
        Ok(j) => {
            let _ = CAP_PCT.set(cap_pct);
            eprintln!(
                "[ptyd] agents job: {} CPU cap, sessions at BelowNormal priority",
                cap_pct.map_or("no".to_string(), |p| format!("{p}%"))
            );
            Some(j)
        }
        Err(e) => {
            let _ = CAP_PCT.set(None);
            eprintln!("[ptyd] agents job unavailable ({e}); sessions run uncapped");
            None
        }
    });
}

fn set_limits(h: HANDLE) -> io::Result<()> {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_PRIORITY_CLASS;
    limits.BasicLimitInformation.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS;
    let ok = unsafe {
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn build_agents(cap_pct: Option<u32>) -> io::Result<Job> {
    let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if h.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = Job(h);
    set_limits(h)?;
    if let Some(pct) = cap_pct {
        let mut info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default();
        info.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
        info.Anonymous.CpuRate = pct * 100; // 1/100 of a percent of ALL processors
        let ok = unsafe {
            SetInformationJobObject(
                h,
                JobObjectCpuRateControlInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(job)
}

pub struct Job(HANDLE);

// A job handle is a kernel handle: usable from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    /// A new job holding `process` (a process handle with
    /// PROCESS_SET_QUOTA | PROCESS_TERMINATE, which CreateProcess's handle has).
    pub fn assign(process: RawHandle) -> io::Result<Job> {
        let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if h.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(h); // closes the handle on any error below
        set_limits(job.0)?; // priority class here too: still BelowNormal if the agents job is missing
        // Parent first, then the session job nests inside it. A failure here
        // (an old Windows, access denied) only costs the cap, never the session.
        if let Some(Some(parent)) = AGENTS.get() {
            if unsafe { AssignProcessToJobObject(parent.0, process as HANDLE) } == 0 {
                eprintln!("[ptyd] session not put in the agents job ({}); it runs uncapped", io::Error::last_os_error());
            }
        }
        if unsafe { AssignProcessToJobObject(job.0, process as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Test hook: the CPU rate (1/100 percent) and flags the job reports.
    #[cfg(test)]
    pub fn cpu_rate(&self) -> Option<(u32, u32)> {
        let mut info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectCpuRateControlInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then(|| (unsafe { info.Anonymous.CpuRate }, info.ControlFlags))
    }

    /// Live processes in the job (nested jobs included), or None if the query fails.
    fn active(&self) -> Option<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(info.ActiveProcesses)
    }

    /// End every process in the job and wait, up to `limit`, until the kernel
    /// counts none alive. `TerminateJobObject` itself only starts termination;
    /// the count drops as each process object actually exits, so `true` means
    /// the whole tree is gone, not merely signalled.
    pub fn terminate(&self, limit: Duration) -> bool {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return false;
        }
        let deadline = Instant::now() + limit;
        loop {
            match self.active() {
                Some(0) => return true,
                None => return false,
                Some(_) if Instant::now() >= deadline => return false,
                Some(_) => std::thread::sleep(Duration::from_millis(1)),
            }
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::process::Command;
    use windows_sys::Win32::System::Threading::GetPriorityClass;

    #[test]
    fn session_job_nests_under_capped_agents_job_at_below_normal() {
        // Not through init_agents (a process-wide OnceLock): build a local agents
        // job and repeat Job::assign's order (parent, then the nested session job).
        let parent = build_agents(Some(60)).expect("agents job");
        let mut child = Command::new("cmd").args(["/c", "ping -n 20 127.0.0.1 >nul"]).spawn().unwrap();
        let h = child.as_raw_handle() as HANDLE;
        assert_ne!(unsafe { AssignProcessToJobObject(parent.0, h) }, 0, "parent assign");
        let session = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        set_limits(session.0).unwrap();
        assert_ne!(unsafe { AssignProcessToJobObject(session.0, h) }, 0, "nested session assign");
        assert_eq!(unsafe { GetPriorityClass(h) }, BELOW_NORMAL_PRIORITY_CLASS);
        let (rate, flags) = parent.cpu_rate().expect("query");
        assert_eq!(rate, 6000);
        assert_eq!(flags, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP);
        assert_eq!(parent.active(), Some(1)); // nested job's process counts in the parent
        assert!(session.terminate(Duration::from_secs(3)));
        assert_eq!(parent.active(), Some(0));
        let _ = child.wait();
    }

    #[test]
    fn session_job_alone_still_sets_below_normal() {
        let mut child = Command::new("cmd").args(["/c", "ping -n 20 127.0.0.1 >nul"]).spawn().unwrap();
        let h = child.as_raw_handle() as HANDLE;
        let session = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        set_limits(session.0).unwrap();
        assert_ne!(unsafe { AssignProcessToJobObject(session.0, h) }, 0);
        assert_eq!(unsafe { GetPriorityClass(h) }, BELOW_NORMAL_PRIORITY_CLASS);
        assert!(session.terminate(Duration::from_secs(3)));
        let _ = child.wait();
    }
}
