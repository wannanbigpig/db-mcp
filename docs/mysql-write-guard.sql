-- Administrator setup ONLY, after reviewing the definer identity and its metadata visibility.
-- Run in the application database, not as the MCP DML identity. Do not grant that identity
-- CREATE ROUTINE / ALTER ROUTINE / TRIGGER / DDL. The trusted definer must see all triggers
-- and inbound/outbound foreign keys for this database (including cross-schema references).
-- Grant only EXECUTE on this procedure plus scoped SELECT/DML to the MCP writer.
-- The fingerprint covers only the metadata columns returned below, not every DDL
-- attribute. CHECK definitions, partition metadata and unselected table options
-- are not fingerprinted. Native constraints still apply during DML. Stop the MCP
-- and discard prepared operations before administrators change untracked schema.
DELIMITER //
CREATE PROCEDURE mcp_write_metadata(IN p_schema VARCHAR(128), IN p_table VARCHAR(128))
SQL SECURITY DEFINER
READS SQL DATA
BEGIN
  IF p_schema <> DATABASE() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Scope denied';
  END IF;
  SELECT ENGINE, TABLE_TYPE FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = p_schema AND TABLE_NAME = p_table LIMIT 257;
  SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = p_schema AND TABLE_NAME = p_table
    ORDER BY ORDINAL_POSITION LIMIT 257;
  SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, SUB_PART, EXPRESSION
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = p_schema AND TABLE_NAME = p_table
    ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT 257;
  SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
    k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      AND r.TABLE_NAME = k.TABLE_NAME
    WHERE (k.TABLE_SCHEMA = p_schema AND k.TABLE_NAME = p_table)
       OR (k.REFERENCED_TABLE_SCHEMA = p_schema AND k.REFERENCED_TABLE_NAME = p_table)
    ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION LIMIT 257;
  SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
    FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = p_schema AND EVENT_OBJECT_TABLE = p_table
    ORDER BY TRIGGER_NAME LIMIT 257;
END//
DELIMITER ;
