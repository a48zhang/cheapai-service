-- Requests own their output limit. No model/channel fallback remains.
ALTER TABLE models DROP COLUMN default_output_tokens;
UPDATE channel_models
SET capabilities_json = json_remove(capabilities_json, '$.defaultOutputTokens'),
    config_version = config_version + 1
WHERE json_type(capabilities_json, '$.defaultOutputTokens') IS NOT NULL;
