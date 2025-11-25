// api/api/index.js
const serverless = require("serverless-http")

// Express app compiled to dist/app.js (we'll add build step)
const app = require("../dist/app").default

module.exports = serverless(app)
