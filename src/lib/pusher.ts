import Pusher from "pusher"

const appId = process.env.PUSHER_APP_ID
const key = process.env.PUSHER_KEY
const secret = process.env.PUSHER_SECRET
const cluster = process.env.PUSHER_CLUSTER

export const pusherConfigured = Boolean(appId && key && secret && cluster)

if (!pusherConfigured) {
  console.warn(
    "Pusher is not fully configured. Set PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, and PUSHER_CLUSTER."
  )
}

export const pusher = pusherConfigured
  ? new Pusher({
      appId: appId!,
      key: key!,
      secret: secret!,
      cluster: cluster!,
      useTLS: true,
    })
  : null
