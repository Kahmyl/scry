ALTER TABLE browser_captures
  DROP CONSTRAINT browser_captures_content_class_check,
  ADD CONSTRAINT browser_captures_content_class_check
    CHECK (content_class IN ('http_json','http_text','http_empty','http_binary','dom_region'));

ALTER TABLE browser_captures
  DROP CONSTRAINT browser_captures_byte_size_check,
  ADD CONSTRAINT browser_captures_byte_size_check
    CHECK (byte_size BETWEEN 0 AND 524288);
