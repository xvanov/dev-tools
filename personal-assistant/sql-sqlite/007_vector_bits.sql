-- A coarse index for nearest-neighbour search (plan 3.4). An exact cosine
-- scan of every 1536-float vector took 500-900 ms over the work stack's 31k
-- chunks; Postgres answers in ~20 ms from an approximate HNSW index. Here
-- each vector also has its sign bits (1536 bits = 192 bytes, pa_bits()) in a
-- narrow table: a search ranks every row by Hamming distance on the bits, then
-- re-ranks the best few hundred by exact cosine on the real vectors. Measured
-- on the work stack: the same top 30 as the exact scan (recall 1.000 over 20
-- queries), ~35 ms with sqlite-vec's vec_distance_hamming (~115 ms with the JS
-- fallback). The vectors themselves are unchanged (D5); the bits are derived
-- from them, locally, by the triggers below.

create table chunk_bits (
  id    integer primary key,
  bits  blob not null
);
create table claim_bits (
  id    integer primary key,
  bits  blob not null
);

insert into chunk_bits (id, bits) select id, pa_bits(embedding) from chunk where embedding is not null;
insert into claim_bits (id, bits) select id, pa_bits(embedding) from claim where embedding is not null;

create trigger chunk_bits_insert after insert on chunk when new.embedding is not null begin
  insert or replace into chunk_bits (id, bits) values (new.id, pa_bits(new.embedding));
end;
create trigger chunk_bits_update after update of embedding on chunk begin
  delete from chunk_bits where id = old.id;
  insert into chunk_bits (id, bits) select new.id, pa_bits(new.embedding) where new.embedding is not null;
end;
create trigger chunk_bits_delete after delete on chunk begin
  delete from chunk_bits where id = old.id;
end;

create trigger claim_bits_insert after insert on claim when new.embedding is not null begin
  insert or replace into claim_bits (id, bits) values (new.id, pa_bits(new.embedding));
end;
create trigger claim_bits_update after update of embedding on claim begin
  delete from claim_bits where id = old.id;
  insert into claim_bits (id, bits) select new.id, pa_bits(new.embedding) where new.embedding is not null;
end;
create trigger claim_bits_delete after delete on claim begin
  delete from claim_bits where id = old.id;
end;
