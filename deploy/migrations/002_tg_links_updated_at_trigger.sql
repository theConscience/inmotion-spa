CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
	NEW.updated_at = NOW();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tg_links_updated_at ON tg_links;

CREATE TRIGGER trg_tg_links_updated_at
BEFORE UPDATE ON tg_links
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
