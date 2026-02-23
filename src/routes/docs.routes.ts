import { Router } from "express"
import { readFile } from "node:fs/promises"
import path from "node:path"

type PostmanCollection = {
  info?: {
    name?: string
    description?: string
  }
  item?: PostmanItem[]
}

type PostmanItem = {
  name?: string
  description?: unknown
  item?: PostmanItem[]
  request?: PostmanRequest
}

type PostmanRequest = {
  method?: string
  description?: unknown
  header?: PostmanHeader[]
  body?: PostmanBody
  url?: string | PostmanUrl
}

type PostmanHeader = {
  key?: string
  value?: string
  disabled?: boolean
}

type PostmanBody = {
  mode?: string
  raw?: string
  urlencoded?: Array<{ key?: string; value?: string; disabled?: boolean }>
  formdata?: Array<{ key?: string; value?: string; disabled?: boolean }>
}

type PostmanUrl = {
  raw?: string
  path?: string[]
  query?: Array<{ key?: string; value?: string; disabled?: boolean }>
}

type OpenApiOperation = {
  summary: string
  description?: string
  tags: string[]
  parameters?: Array<Record<string, unknown>>
  requestBody?: Record<string, unknown>
  security?: Array<Record<string, string[]>>
  responses: Record<string, unknown>
}

const COLLECTION_PATH = path.join(process.cwd(), "docs", "HelpRide-API.postman_collection.json")

const router = Router()
let cachedSpec: Record<string, unknown> | null = null

router.get("/", (_req, res) => {
  res.type("html").send(renderDocsHtml())
})

router.get("/openapi.json", async (_req, res) => {
  try {
    const spec = await getOpenApiSpec()
    res.json(spec)
  } catch (error) {
    console.error("Failed to build OpenAPI docs:", error)
    res.status(500).json({
      error: "Unable to load API docs",
      message: "Postman collection could not be converted to OpenAPI",
    })
  }
})

async function getOpenApiSpec() {
  if (cachedSpec) {
    return cachedSpec
  }

  const collectionRaw = await readFile(COLLECTION_PATH, "utf8")
  const collection = JSON.parse(collectionRaw) as PostmanCollection
  cachedSpec = buildOpenApi(collection)
  return cachedSpec
}

function buildOpenApi(collection: PostmanCollection) {
  const paths: Record<string, Record<string, OpenApiOperation>> = {}
  const tags = new Set<string>()

  walkCollection(collection.item ?? [], [], (item, chain) => {
    if (!item.request) {
      return
    }

    const request = item.request
    const method = normalizeMethod(request.method)
    if (!method) {
      return
    }

    const tag = chain.length > 0 ? chain[chain.length - 1] : "General"
    tags.add(tag)

    const urlInfo = parseRequestUrl(request.url)
    const operationPath = normalizePathTemplate(urlInfo.path)
    const operation: OpenApiOperation = {
      summary: item.name?.trim() || `${method.toUpperCase()} ${operationPath}`,
      tags: [tag],
      responses: {
        "200": {
          description: "Successful response",
        },
      },
    }

    const description = pickDescription(request.description) || pickDescription(item.description)
    if (description) {
      operation.description = description
    }

    const parameters: Array<Record<string, unknown>> = []
    const authHeader = request.header?.find(
      (header) => !header.disabled && header.key?.toLowerCase() === "authorization"
    )
    if (authHeader && authHeader.value?.toLowerCase().includes("bearer")) {
      operation.security = [{ bearerAuth: [] }]
    }

    const extraHeaders = (request.header ?? []).filter((header) => {
      if (header.disabled || !header.key) {
        return false
      }
      const key = header.key.toLowerCase()
      return key !== "authorization" && key !== "content-type"
    })

    for (const header of extraHeaders) {
      parameters.push({
        name: header.key,
        in: "header",
        required: false,
        schema: { type: "string" },
        example: header.value ?? "",
      })
    }

    for (const pathParam of getPathParams(operationPath)) {
      parameters.push({
        name: pathParam,
        in: "path",
        required: true,
        schema: { type: "string" },
      })
    }

    for (const queryParam of urlInfo.query) {
      parameters.push({
        name: queryParam.name,
        in: "query",
        required: false,
        schema: { type: "string" },
        example: queryParam.example,
      })
    }

    if (parameters.length > 0) {
      operation.parameters = dedupeParameters(parameters)
    }

    const requestBody = buildRequestBody(request.body, request.header)
    if (requestBody) {
      operation.requestBody = requestBody
    }

    paths[operationPath] ??= {}

    // Duplicate method/path scenarios exist in the collection (for example invalid token cases).
    // Keep the first one for try-it-out and append scenario names for visibility.
    if (paths[operationPath][method]) {
      const existing = paths[operationPath][method] as OpenApiOperation & {
        "x-altScenarios"?: string[]
      }
      existing["x-altScenarios"] ??= []
      existing["x-altScenarios"].push(operation.summary)
      return
    }

    paths[operationPath][method] = operation
  })

  return {
    openapi: "3.0.3",
    info: {
      title: collection.info?.name || "HelpRide API",
      version: "1.0.0",
      description:
        collection.info?.description ||
        "Interactive API docs generated from the Postman collection.",
    },
    servers: [
      {
        url: "/api",
        description: "Current deployment",
      },
    ],
    tags: Array.from(tags)
      .sort((a, b) => a.localeCompare(b))
      .map((tag) => ({ name: tag })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    paths,
  }
}

function walkCollection(items: PostmanItem[], chain: string[], onRequest: (item: PostmanItem, chain: string[]) => void) {
  for (const item of items) {
    if (item.request) {
      onRequest(item, chain)
    }

    if (item.item && item.item.length > 0) {
      const nextChain = item.name ? [...chain, item.name] : chain
      walkCollection(item.item, nextChain, onRequest)
    }
  }
}

function normalizeMethod(method?: string) {
  const upper = method?.trim().toUpperCase()
  if (!upper) {
    return null
  }
  const allowed = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
  if (!allowed.has(upper)) {
    return null
  }
  return upper.toLowerCase()
}

function parseRequestUrl(url?: string | PostmanUrl) {
  let raw = ""
  let queryFromObject: Array<{ name: string; example: string }> = []

  if (typeof url === "string") {
    raw = url
  } else if (url) {
    if (url.raw) {
      raw = url.raw
    } else {
      const pathPart = url.path && url.path.length > 0 ? `/${url.path.join("/")}` : "/"
      const queryPart = (url.query ?? [])
        .filter((query) => !query.disabled && query.key)
        .map((query) => `${query.key}=${query.value ?? ""}`)
        .join("&")
      raw = queryPart ? `${pathPart}?${queryPart}` : pathPart
    }

    queryFromObject = (url.query ?? [])
      .filter((query) => !query.disabled && query.key)
      .map((query) => ({
        name: query.key as string,
        example: query.value ?? "",
      }))
  }

  const withoutBase = raw.replace(/^\{\{\s*baseUrl\s*\}\}/i, "")
  const absoluteFallback = withoutBase || "/"

  let pathAndQuery = absoluteFallback
  if (/^https?:\/\//i.test(absoluteFallback)) {
    try {
      const parsed = new URL(absoluteFallback)
      pathAndQuery = parsed.pathname + parsed.search
    } catch {
      pathAndQuery = absoluteFallback
    }
  }

  if (!pathAndQuery.startsWith("/")) {
    pathAndQuery = `/${pathAndQuery}`
  }

  const [pathPart, queryPart = ""] = pathAndQuery.split("?")
  const normalizedPath = pathPart.replace(/^\/api(\/|$)/i, "/").replace(/\/{2,}/g, "/")

  const queryFromRaw = queryPart
    ? queryPart
        .split("&")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [name, ...rest] = entry.split("=")
          return {
            name,
            example: rest.join("="),
          }
        })
        .filter((entry) => entry.name)
    : []

  const mergedQuery: Array<{ name: string; example: string }> = []
  const seen = new Set<string>()
  for (const entry of [...queryFromObject, ...queryFromRaw]) {
    if (seen.has(entry.name)) {
      continue
    }
    seen.add(entry.name)
    mergedQuery.push(entry)
  }

  return {
    path: normalizedPath || "/",
    query: mergedQuery,
  }
}

function normalizePathTemplate(inputPath: string) {
  const withParams = inputPath.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, "{$1}")
  if (!withParams.startsWith("/")) {
    return `/${withParams}`
  }
  return withParams || "/"
}

function getPathParams(pathTemplate: string) {
  const params: string[] = []
  const re = /\{([\w.-]+)\}/g
  let match: RegExpExecArray | null = re.exec(pathTemplate)
  while (match) {
    params.push(match[1])
    match = re.exec(pathTemplate)
  }
  return params
}

function dedupeParameters(parameters: Array<Record<string, unknown>>) {
  const seen = new Set<string>()
  return parameters.filter((parameter) => {
    const key = `${parameter.in}:${parameter.name}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function buildRequestBody(body?: PostmanBody, headers?: PostmanHeader[]) {
  if (!body || !body.mode) {
    return undefined
  }

  const contentTypeHeader = headers?.find(
    (header) => !header.disabled && header.key?.toLowerCase() === "content-type"
  )?.value
  const contentType = contentTypeHeader || "application/json"

  if (body.mode === "raw") {
    const raw = (body.raw ?? "").trim()
    if (!raw) {
      return undefined
    }

    const parsed = tryParseJson(raw)
    const schema =
      parsed === undefined
        ? { type: "string" }
        : Array.isArray(parsed)
          ? { type: "array" }
          : typeof parsed === "object" && parsed !== null
            ? { type: "object" }
            : { type: typeof parsed }

    return {
      required: true,
      content: {
        [contentType]: {
          schema,
          example: parsed === undefined ? raw : parsed,
        },
      },
    }
  }

  if (body.mode === "urlencoded" || body.mode === "formdata") {
    const entries = body.mode === "urlencoded" ? body.urlencoded ?? [] : body.formdata ?? []
    const example = Object.fromEntries(
      entries
        .filter((entry) => !entry.disabled && entry.key)
        .map((entry) => [entry.key as string, entry.value ?? ""])
    )
    const modeContentType =
      body.mode === "formdata" ? "multipart/form-data" : "application/x-www-form-urlencoded"

    return {
      required: Object.keys(example).length > 0,
      content: {
        [modeContentType]: {
          schema: {
            type: "object",
            additionalProperties: true,
          },
          example,
        },
      },
    }
  }

  return undefined
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function pickDescription(description: unknown) {
  if (typeof description === "string") {
    const normalized = description.trim()
    return normalized || undefined
  }
  if (
    description &&
    typeof description === "object" &&
    "content" in description &&
    typeof (description as { content?: unknown }).content === "string"
  ) {
    const content = (description as { content?: string }).content?.trim()
    return content || undefined
  }
  return undefined
}

function renderDocsHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HelpRide API Docs</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      :root {
        --cream: #f7f4ed;
        --ink: #1d2a39;
        --teal: #006d77;
        --amber: #e2952a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: "Space Grotesk", sans-serif;
        background:
          radial-gradient(circle at 15% 15%, rgba(0, 109, 119, 0.15), transparent 45%),
          radial-gradient(circle at 85% 0%, rgba(226, 149, 42, 0.18), transparent 35%),
          var(--cream);
      }

      .hero {
        padding: 2rem 2.25rem 1.5rem;
      }

      .hero h1 {
        margin: 0 0 0.65rem;
        font-size: clamp(1.8rem, 3vw, 2.6rem);
        letter-spacing: -0.02em;
      }

      .hero p {
        margin: 0;
        max-width: 760px;
        font-size: 0.98rem;
      }

      .shell {
        margin: 0 1.3rem 1.4rem;
        border-radius: 16px;
        border: 1px solid rgba(29, 42, 57, 0.16);
        background: rgba(255, 255, 255, 0.87);
        box-shadow: 0 18px 40px rgba(29, 42, 57, 0.09);
        overflow: hidden;
      }

      #swagger-ui .topbar {
        display: none;
      }

      #swagger-ui .info,
      #swagger-ui .scheme-container {
        background: transparent;
        box-shadow: none;
      }

      #swagger-ui .info .title {
        font-family: "Space Grotesk", sans-serif;
      }

      #swagger-ui .opblock .opblock-summary-path {
        font-family: "IBM Plex Mono", monospace;
      }

      #swagger-ui .btn.authorize {
        background: var(--teal);
        border-color: var(--teal);
      }

      #swagger-ui .opblock-tag {
        font-family: "Space Grotesk", sans-serif;
      }

      #swagger-ui .response-col_status,
      #swagger-ui .parameter__name {
        font-family: "IBM Plex Mono", monospace;
      }

      @media (max-width: 760px) {
        .hero {
          padding: 1.3rem 1.1rem 1rem;
        }

        .shell {
          margin: 0 0.7rem 0.7rem;
          border-radius: 12px;
        }
      }
    </style>
  </head>
  <body>
    <header class="hero">
      <h1>HelpRide API Endpoint Tester</h1>
      <p>
        Interactive API docs powered by your Postman collection. Use "Try it out" on any endpoint, set JWT in
        Authorize, and test directly against this deployment.
      </p>
    </header>
    <main class="shell">
      <div id="swagger-ui"></div>
    </main>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/docs/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: true,
        filter: true,
        tryItOutEnabled: true,
        defaultModelsExpandDepth: -1,
        docExpansion: "list",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      })
    </script>
  </body>
</html>`
}

export default router
