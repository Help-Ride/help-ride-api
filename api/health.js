// api/health.js  (repo root: HELP-RIDE-API/api/health.js)

export default function handler(req, res) {
  res.status(200).json({
    status: "okkk",
    time: new Date().toISOString(),
  })
}
