use std::sync::Arc;

use xal_host::*;
use xal_providers::{catalog::Model, client::Client};

pub struct TextProvider {
    pub client: Client,
    pub models: Vec<Model>,
}
impl Plugin for TextProvider {
    fn name(&self) -> &str {
        self.client.id.plugin()
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let client = self.client.clone();
        let settlement = client.clone();
        let models = Arc::new(self.models.clone());
        registration.provider(
            self.client.id.as_str(),
            Provider {
                settle: Some(Box::new(move || {
                    let client = settlement.clone();
                    Box::pin(async move { client.settle_refresh().await })
                })),
                models: models.iter().map(|m| m.id.clone()).collect(),
                stream: Box::new(move |request, context, sender| {
                    let client = client.clone();
                    let models = models.clone();
                    Box::pin(async move {
                        let model =
                            models
                                .iter()
                                .find(|m| m.id == request.model)
                                .ok_or_else(|| {
                                    Error::Failed("model is not available in this profile".into())
                                })?;
                        client
                            .stream(model, request, &context.cancellation, sender)
                            .await
                    })
                }),
            },
        )
    }
}

pub struct TypeSafe(pub Client);
impl Plugin for TypeSafe {
    fn name(&self) -> &str {
        "typesafe"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.decision("typesafe", xal_providers::decision::handler(self.0.clone()))
    }
}
