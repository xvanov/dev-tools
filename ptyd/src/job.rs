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
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

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
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { AssignProcessToJobObject(job.0, process as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
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
