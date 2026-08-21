use super::*;

pub(super) fn request_input_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let values = request
        .get("questions")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| invalid("questions must contain at least one entry"))?;
    let mut ids = HashSet::new();
    let mut questions = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let question = value
            .as_object()
            .ok_or_else(|| invalid(format!("questions[{index}] must be an object")))?;
        let id = required_nested(question, "id", &format!("questions[{index}].id"))?;
        let mut chars = id.chars();
        if !chars.next().is_some_and(|value| value.is_ascii_lowercase())
            || !chars
                .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '_')
        {
            return Err(invalid(format!(
                "questions[{index}].id must use lower-case letters, numbers, and underscores"
            )));
        }
        if !ids.insert(id.clone()) {
            return Err(invalid("questions must have unique ids"));
        }
        let header = required_nested(question, "header", &format!("questions[{index}].header"))?;
        let text = required_nested(
            question,
            "question",
            &format!("questions[{index}].question"),
        )?;
        let options = question
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(format!("questions[{index}].options must be an array")))?;
        let mut labels = HashSet::new();
        let mut parsed = Vec::with_capacity(options.len());
        for (option_index, option) in options.iter().enumerate() {
            let option = option.as_object().ok_or_else(|| {
                invalid(format!(
                    "questions[{index}].options[{option_index}] must be an object"
                ))
            })?;
            let label = required_nested(
                option,
                "label",
                &format!("questions[{index}].options[{option_index}].label"),
            )?;
            let description = required_nested(
                option,
                "description",
                &format!("questions[{index}].options[{option_index}].description"),
            )?;
            if !labels.insert(label.to_ascii_lowercase()) {
                return Err(invalid(format!(
                    "questions[{index}].options must have unique labels"
                )));
            }
            parsed.push(json!({ "label": label, "description": description }));
        }
        questions.push(json!({ "id": id, "header": header, "question": text, "options": parsed }));
    }
    Ok(json!({ "questions": questions }))
}

fn required_nested(value: &Map<String, Value>, key: &str, field: &str) -> napi::Result<String> {
    string(value, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{field} is required")))
}

pub(super) fn request_input_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    if string(request, "status") == Some("rejected") {
        return Ok(json!({ "output": "{\"status\":\"rejected\"}" }));
    }
    if string(request, "status") != Some("answered") {
        return Err(invalid("native input result is invalid"));
    }
    let answers = request
        .get("answers")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("native input result is invalid"))?;
    let mut output = Map::new();
    for answer in answers {
        let answer = object(answer)?;
        output.insert(
            required_string(answer, "questionId")?,
            Value::String(required_string(answer, "value")?),
        );
    }
    Ok(
        json!({ "output": serde_json::to_string(&json!({ "status": "answered", "answers": output })).map_err(|error| invalid(error.to_string()))? }),
    )
}

#[cfg(test)]
mod tests {
    use super::{request_input_prepare, run};

    #[test]
    fn validates_questions() {
        let question = run(
            r#"{"questions":[{"id":"choice","header":"Choice","question":"Choose","options":[{"label":"One","description":"First"}]}]}"#.to_owned(),
            request_input_prepare,
        )
        .unwrap();
        assert!(question.contains("choice"));
    }
}
