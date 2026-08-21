use super::*;

pub(super) fn memory_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let operation = string(request, "operation")
        .ok_or_else(|| invalid("operation must be read, replace, or clear"))?;
    if !matches!(operation, "read" | "replace" | "clear") {
        return Err(invalid("operation must be read, replace, or clear"));
    }
    let mut output = json!({ "operation": operation });
    if operation != "read" {
        let revision = required_string(request, "revision")
            .map_err(|_| invalid("revision is required; read global memory before changing it"))?;
        output
            .as_object_mut()
            .ok_or_else(|| invalid("native memory request is invalid"))?
            .insert("revision".to_owned(), json!(revision));
    }
    if operation == "replace" {
        let content = string(request, "content")
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| {
                invalid("content is required for replace; use clear to erase global memory")
            })?;
        output
            .as_object_mut()
            .ok_or_else(|| invalid("native memory request is invalid"))?
            .insert("content".to_owned(), json!(content));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{memory_prepare, run};

    #[test]
    fn rejects_empty_memory_replacements() {
        assert!(
            run(
                r#"{"operation":"replace","revision":"revision","content":"  "}"#.to_owned(),
                memory_prepare,
            )
            .is_err()
        );
        assert!(
            run(
                r#"{"operation":"clear","revision":"revision"}"#.to_owned(),
                memory_prepare,
            )
            .is_ok()
        );
    }
}
