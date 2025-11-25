// api/api/index.ts
import serverless from "serverless-http"
import app from "../dist/app" // after build

export default serverless(app)
