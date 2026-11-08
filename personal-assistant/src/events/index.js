'use strict';

// This process's event bus (src/events/bus.js) and what feeds it.
//
// Writers do not publish by hand. Postgres triggers on the tables the views
// show (sql/034_events_notify.sql: commitment, run, proposal, draft,
// factory_board, routine, …) send `pg_notify('pa_events', {topic, table, op,
// id, …})` at commit, so every writer is covered whatever process it runs in:
// the worker's passes, `pa` on the command line, the MCP server Jarvis calls,
// and the previous worker generation still finishing its passes during a roll.
// One dedicated connection LISTENs and republishes each notification on the
// bus; GET /api/events (src/dashboard/events.js) streams the bus.
//
// The listener starts with the first stream, not with the worker: it serves
// the dashboard, which a supervised generation brings up before it holds the
// worker lock, and it is not background work (AGENT.md, "How the worker runs").
//
// Item 1.4 replaces NOTIFY with an outbox table the triggers insert into; the
// bus keeps its (topic, id, payload) shape so nothing above it changes.

const { createBus, TOPIC } = require('./bus');
const { logger } = require('../log');

const log = logger('events');
const CHANNEL = 'pa_events';

let shared = null;
function bus() {
  if (!shared) shared = createBus();
  return shared;
}

/** Publishes in this process only (a change no table records). */
function publish(topic, payload) {
  return bus().publish(topic, payload);
}

/** Pure. A NOTIFY payload as {topic, payload}, or null when it is not one of ours. */
function fromNotify(text) {
  let o;
  try {
    o = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.topic !== 'string' || !TOPIC.test(o.topic)) return null;
  const { topic, ...payload } = o;
  return { topic, payload };
}

/**
 * LISTENs on CHANNEL over one connection from `connect()` and calls
 * onEvent({topic, payload}) per notification. A dropped connection is
 * reopened (with backoff); notifications sent while it was down are lost, so
 * each reconnect calls onReconnect() and the pages refetch once.
 */
function createListener({ connect, onEvent, onReconnect = () => {}, retryMs = [500, 1000, 2000, 5000, 15000] }) {
  let current = null;
  let stopped = false;
  let connectedOnce = false;
  let attempt = 0;
  let timer = null;

  function schedule() {
    if (stopped || timer) return;
    const wait = retryMs[Math.min(attempt++, retryMs.length - 1)];
    timer = setTimeout(() => {
      timer = null;
      open();
    }, wait);
    timer.unref?.();
  }

  async function open() {
    if (stopped || current) return;
    let client = null;
    try {
      client = await connect();
      const drop = (err) => {
        if (current !== client) return;
        current = null;
        log.debug('event feed dropped', { message: err?.message || 'ended' });
        Promise.resolve(client.end?.()).catch(() => {});
        schedule();
      };
      client.on('error', drop);
      client.on('end', drop);
      client.on('notification', (n) => {
        if (n.channel !== CHANNEL) return;
        const e = fromNotify(n.payload);
        if (e) onEvent(e);
      });
      await client.query(`listen ${CHANNEL}`);
      if (stopped) return Promise.resolve(client.end?.()).catch(() => {});
      current = client;
      attempt = 0;
      if (connectedOnce) onReconnect();
      connectedOnce = true;
    } catch (err) {
      log.debug('event feed not connected — retrying', { message: err.message });
      if (client) Promise.resolve(client.end?.()).catch(() => {});
      schedule();
    }
  }

  open();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      const c = current;
      current = null;
      if (c) return Promise.resolve(c.end?.()).catch(() => {});
      return Promise.resolve();
    },
    connected: () => Boolean(current),
  };
}

let listening = null;

/** Starts the Postgres feed for this process's bus, once. */
function ensureListening() {
  if (listening) return listening;
  const { config } = require('../config');
  listening = createListener({
    connect: async () => {
      const { Client } = require('pg');
      const c = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10_000 });
      await c.connect();
      return c;
    },
    onEvent: (e) => bus().publish(e.topic, e.payload),
    onReconnect: () => bus().publish('resync', { reason: 'the event feed reconnected' }),
  });
  return listening;
}

/** Tests only: a stand-in for ensureListening (the endpoint calls it per stream). */
let listenHook = null;
function _setListen(fn) {
  listenHook = fn;
}
function listen() {
  return listenHook ? listenHook() : ensureListening();
}

module.exports = { bus, publish, fromNotify, createListener, ensureListening, listen, _setListen, CHANNEL };
