
# 🎥 Zoom Meeting MoM Generator with Cloud & Local Audio Support

This application automates the generation and delivery of **Minutes of Meeting (MoM)** from Zoom recordings using AI transcription and email integration.

## 🧩 Features

* ✅ Zoom OAuth 2.0 Authentication
* ✅ Outlook OAuth 2.0 for Email Delivery
* ✅ Local File Watcher for Zoom audio recordings (`.m4a`, `.mp3`, etc.)
* ✅ **Zoom Cloud Recording API Support for Pro Users**
* ✅ AI-Powered Transcription using Groq API
* ✅ Gemini-Powered MoM Generation
* ✅ Participant fetching from Zoom Reports API
* ✅ Auto-email MoM to attendees
* ✅ SQLite-based persistent meeting tracking
* ✅ File deduplication and hourly cron job scheduling

---

## 🔐 Prerequisites

| Service         | Requirement                                         |
| --------------- | --------------------------------------------------- |
| Zoom            | OAuth App (Client ID/Secret), Pro Account for Cloud |
| Outlook         | OAuth App in Azure (Client ID/Secret)               |
| Groq            | API Key for audio transcription                     |
| Gemini (Google) | API Key for content generation                      |

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/Ganesh-73005/ZOOM_MOM_GEN.git
cd zoom-mom-ai
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up `.env`

Create a `.env` file and fill in the following values:

```dotenv
PORT=3000

# Zoom
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
ZOOM_REDIRECT_URI=http://localhost:3000/auth/zoom/callback

# Outlook
OUTLOOK_CLIENT_ID=your_outlook_client_id
OUTLOOK_CLIENT_SECRET=your_outlook_client_secret
OUTLOOK_REDIRECT_URI=http://localhost:3000/auth/outlook/callback

# API Keys
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key

# Local Audio Directory (optional if using Zoom Cloud)
ZOOM_RECORDINGS_PATH=C:\\Users\\YourName\\Documents\\Zoom

# Optional fallback email
DEFAULT_EMAIL=user@example.com
```

---

## 📂 Option A: Local Recordings (Default for Free Zoom Users)

This app watches a local folder for Zoom audio recordings (e.g. `.m4a`, `.mp3`) and:

* Transcribes audio
* Extracts meeting metadata
* Generates MoM
* Emails participants using Outlook

### 👉 Enable Local File Watching:

Ensure `ZOOM_RECORDINGS_PATH` is correctly set in `.env`.

---

## ☁️ Option B: Zoom Cloud Recording (Recommended for Pro Users)

Zoom Pro users can utilize **Zoom Cloud Recordings** to bypass local storage and automate everything via API.

### ✅ Benefits:

* No need to manually download audio
* Process directly from Zoom servers
* More secure and scalable

### 📌 Required OAuth Scopes:

```
recording:read
meeting:read
report:read:list_meeting_participants:admin
user:read
```

### 🔧 Setup Instructions

1. Ensure your Zoom account is Pro-level.
2. In your Zoom App credentials (OAuth App), enable the following scopes:

   * `recording:read`
   * `meeting:read`
   * `report:read:admin`
3. Enable Cloud Recording in Zoom settings.
4. Authenticate via:

```
GET http://localhost:3000/auth/zoom
```

5. Once authenticated, the backend will:

   * Fetch meetings from `/users/me/meetings`
   * Access cloud recordings from `/meetings/{meetingId}/recordings`
   * Transcribe + generate MoM automatically

---

## 📨 Authenticate & Run

1. Start the server:

```bash
node app.js
```

2. In browser:

   * Visit: `http://localhost:3000/auth/zoom`
   * Then: `http://localhost:3000/auth/outlook`

> The system auto-starts after both authentications.

---

## ⏱ Automation

* Scans recent local files on startup
* Runs `cron` job every hour to auto-process new meetings from Zoom
* Skips already processed files using DB

---

## 📦 Database

Uses SQLite (`meetings.db`) to store:

* Meetings
* Participants
* Processed files

---

## 📁 Endpoints

| Endpoint              | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `/auth/zoom`          | Initiate Zoom OAuth                       |
| `/auth/outlook`       | Initiate Outlook OAuth                    |
| `/process-audio-file` | Process a given local audio file manually |
| `/processed-meetings` | View processed meetings                   |
| `/auth-status`        | View current auth state                   |

---

## 📌 Notes

* 💡 You **must** authenticate both Zoom and Outlook for full automation.
* 🧠 AI transcription and MoM are powered by Groq and Gemini respectively.
* ⚙️ Outlook emails are sent via Microsoft Graph API.

---

## 📞 Support

For any issues, reach out to your backend team or raise a GitHub issue.


