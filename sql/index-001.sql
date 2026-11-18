CREATE TABLE projection (
  tenant text NOT NULL, gen integer NOT NULL, id integer NOT NULL,
  version bigint NOT NULL, title text NOT NULL, body text NOT NULL, deleted boolean NOT NULL,
  mapping integer NOT NULL,
  terms tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english',title), 'A') ||
    setweight(to_tsvector('english',body), CASE WHEN mapping=2 THEN 'D'::"char" ELSE 'A'::"char" END)
  ) STORED,
  PRIMARY KEY(tenant,gen,id)
);
CREATE INDEX projection_search ON projection USING gin(terms) WHERE NOT deleted;
