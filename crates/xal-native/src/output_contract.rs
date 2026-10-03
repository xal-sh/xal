use napi_derive::napi;
#[napi]
pub struct NativeOutputContract(xal_services::output_contract::OutputContract);
#[napi]
impl NativeOutputContract {
    #[napi(constructor, catch_unwind)]
    pub fn new(schema: String) -> napi::Result<Self> {
        Ok(Self(
            xal_services::output_contract::OutputContract::new(schema)
                .map_err(crate::tool_contracts::io_error)?,
        ))
    }
    #[napi(getter, catch_unwind)]
    pub fn output(&self) -> Option<String> {
        self.0.output()
    }
    #[napi(getter, catch_unwind)]
    pub fn exhausted(&self) -> bool {
        self.0.exhausted()
    }
    #[napi(catch_unwind)]
    pub fn reset(&mut self) {
        self.0.reset();
    }
    #[napi(catch_unwind)]
    pub fn missing(&mut self) -> String {
        self.0.missing()
    }
    #[napi(catch_unwind)]
    pub fn failure(&self) -> String {
        self.0.failure()
    }
    #[napi(catch_unwind)]
    pub fn submit(&mut self, value: Option<String>) -> napi::Result<String> {
        self.0
            .submit(value)
            .map_err(crate::tool_contracts::io_error)
    }
}
