type DispatchPayload = {
  rideRequestId: string
  pickupName?: string
  pickupLat: number
  pickupLng: number
  dropoffName?: string
  dropoffLat?: number
  dropoffLng?: number
}

type CancelDispatchPayload = {
  rideRequestId: string
}

function extractRideRequestId(payload: object) {
  const record = payload as Record<string, unknown>
  const id = record.rideRequestId
  return typeof id === "string" ? id : null
}

function getRealtimeBaseUrl() {
  const baseUrl = process.env.REALTIME_BASE_URL
  if (!baseUrl) {
    throw new Error("REALTIME_BASE_URL is not set")
  }
  return baseUrl
}

export function getRealtimeToApiSecret() {
  const secret = process.env.REALTIME_TO_API_SECRET
  if (!secret) {
    throw new Error("REALTIME_TO_API_SECRET is not set")
  }
  return secret
}

async function postToRealtime(path: string, payload: object) {
  const baseUrl = getRealtimeBaseUrl()
  const secret = getRealtimeToApiSecret()
  const url = new URL(path, baseUrl).toString()
  const rideRequestId = extractRideRequestId(payload)

  console.info(
    "[realtime] sending request",
    JSON.stringify({
      path,
      url,
      rideRequestId,
    })
  )

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-REALTIME-SECRET": secret,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error(
      "[realtime] request failed",
      JSON.stringify({
        path,
        url,
        status: response.status,
        statusText: response.statusText,
        rideRequestId,
        body: body.slice(0, 500),
      })
    )
    throw new Error(
      `Realtime API request failed (${response.status} ${response.statusText}) ${body}`.trim()
    )
  }

  console.info(
    "[realtime] request completed",
    JSON.stringify({
      path,
      url,
      status: response.status,
      rideRequestId,
    })
  )
}

export async function dispatchRideRequest(payload: DispatchPayload) {
  await postToRealtime("/dispatch", payload)
}

export async function dispatchRideRequestCancel(payload: CancelDispatchPayload) {
  await postToRealtime("/dispatch/cancel", payload)
}
