CREATE TABLE tenants (
  tenant text PRIMARY KEY,
  head bigint NOT NULL DEFAULT 0,
  active integer,
  next_generation integer NOT NULL DEFAULT 1
);
CREATE TABLE documents (
  tenant text REFERENCES tenants,
  id integer CHECK (id > 0),
  version bigint NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  body text NOT NULL CHECK (length(body) <= 8192),
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant,id)
);
CREATE TABLE changes (
  tenant text REFERENCES tenants,
  version bigint,
  contract integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant,version)
);
CREATE TABLE generations (
  tenant text REFERENCES tenants,
  gen integer,
  mapping integer NOT NULL CHECK (mapping IN (1,2)),
  phase text NOT NULL CHECK (phase IN ('scan','tail','retired')),
  checkpoint bigint NOT NULL,
  scan_id integer NOT NULL DEFAULT 0,
  ceiling integer NOT NULL,
  error text,
  failures integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant,gen)
);
CREATE FUNCTION assign_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Use a tombstone'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.tenant,OLD.id) <> (NEW.tenant,NEW.id)
    THEN RAISE EXCEPTION 'Immutable document key'; END IF;
  UPDATE tenants SET head=head+1 WHERE tenant=NEW.tenant RETURNING head INTO NEW.version;
  IF EXISTS (SELECT 1 FROM generations WHERE tenant=NEW.tenant AND phase<>'retired' AND NEW.version-checkpoint>10000)
    THEN RAISE EXCEPTION USING ERRCODE='P5501', MESSAGE='Projection backlog is full'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version BEFORE INSERT OR UPDATE OR DELETE ON documents
FOR EACH ROW EXECUTE FUNCTION assign_version();
CREATE FUNCTION capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO changes(tenant,version,payload)
    VALUES(NEW.tenant,NEW.version,to_jsonb(NEW) || jsonb_build_object('version',NEW.version::text));
  RETURN NULL;
END $$;
CREATE TRIGGER capture AFTER INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION capture_change();
