# API spec

<!--
Each endpoint a row. Include method, path, request body shape (or "(none)"),
response body shape, success status code, error status codes + when each is
returned.
-->

## Endpoints

### `METHOD /path`

- **Method:** GET | POST | PUT | PATCH | DELETE
- **Path:** `/path/here`
- **Request body:** `(none)` or
  ```json
  { "field": "type" }
  ```
- **Response body (success):**
  ```json
  { "field": "type" }
  ```
- **Success status:** `200`
- **Error statuses:**
  - `400` — invalid input
  - `404` — not found
  - `500` — internal error
