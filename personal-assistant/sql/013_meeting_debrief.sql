-- Post-meeting debriefs (src/meetings/debrief.js).
--
-- One row per debrief of a recorded meeting or call: which episode, which
-- calendar occurrence, and `applied` — every change it made, each with the
-- verbatim quote it rests on and what it replaced, so the dashboard can show
-- it and undo any one item. "Work to do" is a query over audio_episode with
-- no row here for the episode's current transcript (`content_hash`); a
-- meeting that grows after its debrief gets a second one, which reads the
-- first one's to-dos as open commitments and does not repeat them.
--
-- A failed debrief is a row too (`error`, `attempts`), so a transcript the
-- model cannot handle is tried three times, not every two minutes forever.

create table if not exists meeting_debrief (
  id                bigserial primary key,
  episode_id        bigint not null references audio_episode(id) on delete cascade,
  event_external_id text,
  source_item_id    bigint references source_item(id) on delete set null,
  title             text not null,
  started_at        timestamptz not null,
  ended_at          timestamptz not null,
  content_hash      text not null,
  transcript_chars  int not null default 0,
  applied           jsonb not null default '{"items": []}'::jsonb,
  dropped           int not null default 0,          -- model items whose quote was not in the transcript
  error             text,
  attempts          int not null default 0,
  extracted_by      text not null,
  notification_id   bigint references notification(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (episode_id, content_hash)
);

create index if not exists meeting_debrief_created_idx on meeting_debrief (created_at desc);
