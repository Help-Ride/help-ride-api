const serverless = require("serverless-http")
const app = require("../dist/app").default

module.exports = serverless(app)
