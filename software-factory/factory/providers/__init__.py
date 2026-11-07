"""Provider-specific bootstrap helpers.

Currently only ``azure_foundry`` lives here; future providers (Bedrock,
Vertex AI, etc.) can follow the same shape: a module that exposes
``ensure_bootstrapped()`` and is invoked once from ``factory.runner``
before any LLM call.
"""
