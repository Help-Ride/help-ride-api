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
    throw new Error(
      `Realtime API request failed (${response.status} ${response.statusText}) ${body}`.trim()
    )
  }
}

export async function dispatchRideRequest(payload: DispatchPayload) {
  await postToRealtime("/dispatch", payload)
}

export async function dispatchRideRequestCancel(payload: CancelDispatchPayload) {
  await postToRealtime("/dispatch/cancel", payload)
}
