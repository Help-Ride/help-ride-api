erDiagram
USERS {
uuid id PK
string name
string email
string phone
string password_hash
string role_default "passenger|driver"
string provider_avatar_url
boolean email_verified
datetime created_at
datetime updated_at
}

    OAUTH_ACCOUNTS {
        uuid id PK
        uuid user_id FK
        string provider        "google|apple"
        string provider_user_id
        string provider_email
        string access_token
        string refresh_token
        datetime created_at
        datetime updated_at
    }

    DRIVER_PROFILES {
        uuid id PK
        uuid user_id FK
        string car_make
        string car_model
        string car_color
        string plate_number
        string license_number
        boolean is_verified
        datetime created_at
        datetime updated_at
    }

    RIDES {
        uuid id PK
        uuid driver_id FK
        string from_city
        float from_lat
        float from_lng
        string to_city
        float to_lat
        float to_lng
        datetime start_time
        numeric price_per_seat
        int seats_total
        int seats_available
        string status       "open|ongoing|completed|cancelled"
        datetime created_at
        datetime updated_at
    }

    BOOKINGS {
        uuid id PK
        uuid ride_id FK
        uuid passenger_id FK
        int seats_booked
        string status           "pending|confirmed|cancelled"
        string payment_status   "unpaid|paid|refunded"
        string stripe_payment_intent_id
        datetime created_at
        datetime updated_at
    }

    PAYMENTS {
        uuid id PK
        uuid booking_id FK
        numeric amount
        string currency
        string stripe_payment_intent_id
        string status         "requires_payment|succeeded|failed|refunded"
        datetime created_at
    }

    NOTIFICATIONS {
        uuid id PK
        uuid user_id FK
        string title
        string body
        string type          "ride_update|payment|system"
        boolean is_read
        datetime created_at
    }

    SOS_EVENTS {
        uuid id PK
        uuid user_id FK
        uuid ride_id FK
        float lat
        float lng
        datetime created_at
    }

    %% Relationships
    USERS ||--o{ OAUTH_ACCOUNTS : "has"
    USERS ||--o{ DRIVER_PROFILES : "has"
    USERS ||--o{ RIDES : "creates"
    USERS ||--o{ BOOKINGS : "makes"
    USERS ||--o{ NOTIFICATIONS : "receives"
    USERS ||--o{ SOS_EVENTS : "triggers"

    RIDES ||--o{ BOOKINGS : "has"
    RIDES ||--o{ SOS_EVENTS : "related to"

    BOOKINGS ||--o{ PAYMENTS : "generates"
