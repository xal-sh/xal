use std::io;

use serde_json::Value;

pub fn validator(schema: &Value) -> io::Result<jsonschema::Validator> {
    jsonschema::options()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid JSON Schema: {error}"),
            )
        })
}

pub fn validate(schema: &Value, value: &Value) -> io::Result<()> {
    let validator = validator(schema)?;
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "invalid tool arguments at {}: {error}",
                error.instance_path()
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schemas_allow_local_references_but_never_read_external_resources() {
        for reference in [
            "https://example.invalid/schema",
            "file:///not-a-schema.json",
        ] {
            assert!(validator(&json!({"$ref":reference})).is_err());
        }
        let schema = json!({"$defs":{"value":{"type":"integer"}},"$ref":"#/$defs/value"});
        validate(&schema, &json!(3)).unwrap();
        assert!(validate(&schema, &json!("three")).is_err());
    }
}
