<!-- This file is CURRENT-STATE-ONLY. Do not preserve past states. -->
<!-- Rewrite diagrams whenever the system changes; do not append old versions. -->

# Architecture diagrams

## Component overview

```mermaid
flowchart LR
    Client["Client"] -->|HTTP| API["API service"]
    API --> DB[("Datastore")]
```

## Request flow: <name the canonical user flow>

```mermaid
sequenceDiagram
    actor User
    participant Client
    participant API
    participant DB
    User->>Client: action
    Client->>API: request
    API->>DB: query
    DB-->>API: result
    API-->>Client: response
```
