-- Keyword search (plan 3.1): FTS5 tables in place of Postgres's generated
-- tsvector columns and their gin indexes. Each is an external-content table
-- over its row (no second copy of the text), kept in step by the triggers
-- below, and keyed by the row's id (rowid), so a search joins back by id.
--
--   Postgres (sql/001, 003, 005)                         SQLite
--   chunk.tsv        english(context || content)          chunk_fts        porter
--   chunk.tsv_exact  simple(context || content)           chunk_fts_exact  unicode61 (no stemming)
--   claim.tsv        english(subject_label, text, quote)  claim_fts        porter
--   memory_page.tsv  english(title || body)               memory_page_fts  porter
--
-- Ranking differs (bm25() here, ts_rank there) and porter keeps English stop
-- words; plan 3.4 compares results on the recorded query set and recalibrates.
--
-- Vectors (embedding columns, declared `vector`) are BLOBs of 1536
-- little-endian float32 (D5: copied across, never re-embedded). Nearest
-- neighbours are an exact scan, `order by vec_distance_cosine(embedding, $1)`
-- (sqlite-vec, or the same function in JS: src/db/sqlite.js); DESIGN.md puts
-- an index past ~1M vectors.

create virtual table chunk_fts using fts5(context, content, content = 'chunk', content_rowid = 'id', tokenize = 'porter unicode61');
create virtual table chunk_fts_exact using fts5(context, content, content = 'chunk', content_rowid = 'id', tokenize = 'unicode61');

create trigger chunk_fts_insert after insert on chunk begin
  insert into chunk_fts (rowid, context, content) values (new.id, new.context, new.content);
  insert into chunk_fts_exact (rowid, context, content) values (new.id, new.context, new.content);
end;
create trigger chunk_fts_delete after delete on chunk begin
  insert into chunk_fts (chunk_fts, rowid, context, content) values ('delete', old.id, old.context, old.content);
  insert into chunk_fts_exact (chunk_fts_exact, rowid, context, content) values ('delete', old.id, old.context, old.content);
end;
create trigger chunk_fts_update after update of context, content on chunk begin
  insert into chunk_fts (chunk_fts, rowid, context, content) values ('delete', old.id, old.context, old.content);
  insert into chunk_fts_exact (chunk_fts_exact, rowid, context, content) values ('delete', old.id, old.context, old.content);
  insert into chunk_fts (rowid, context, content) values (new.id, new.context, new.content);
  insert into chunk_fts_exact (rowid, context, content) values (new.id, new.context, new.content);
end;

create virtual table claim_fts using fts5(subject_label, text, quote, content = 'claim', content_rowid = 'id', tokenize = 'porter unicode61');

create trigger claim_fts_insert after insert on claim begin
  insert into claim_fts (rowid, subject_label, text, quote) values (new.id, new.subject_label, new.text, new.quote);
end;
create trigger claim_fts_delete after delete on claim begin
  insert into claim_fts (claim_fts, rowid, subject_label, text, quote) values ('delete', old.id, old.subject_label, old.text, old.quote);
end;
create trigger claim_fts_update after update of subject_label, text, quote on claim begin
  insert into claim_fts (claim_fts, rowid, subject_label, text, quote) values ('delete', old.id, old.subject_label, old.text, old.quote);
  insert into claim_fts (rowid, subject_label, text, quote) values (new.id, new.subject_label, new.text, new.quote);
end;

create virtual table memory_page_fts using fts5(title, body, content = 'memory_page', content_rowid = 'id', tokenize = 'porter unicode61');

create trigger memory_page_fts_insert after insert on memory_page begin
  insert into memory_page_fts (rowid, title, body) values (new.id, new.title, new.body);
end;
create trigger memory_page_fts_delete after delete on memory_page begin
  insert into memory_page_fts (memory_page_fts, rowid, title, body) values ('delete', old.id, old.title, old.body);
end;
create trigger memory_page_fts_update after update of title, body on memory_page begin
  insert into memory_page_fts (memory_page_fts, rowid, title, body) values ('delete', old.id, old.title, old.body);
  insert into memory_page_fts (rowid, title, body) values (new.id, new.title, new.body);
end;
