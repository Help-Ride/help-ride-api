import app from "./index.js"

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`API server running on port ${PORT}`))
