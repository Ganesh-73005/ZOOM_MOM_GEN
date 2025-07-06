import dotenv from "dotenv";
dotenv.config();
import express from "express";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import session from "express-session";
import crypto from "crypto";
import cors from "cors";
import sqlite3 from "sqlite3";
import { Client } from "@microsoft/microsoft-graph-client";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import chokidar from "chokidar";
import Groq from "groq-sdk";

const app = express()
app.use(express.json())

// CORS Configuration
app.use(
  cors({
    origin: ["https://ganesh-73005.github.io", "http://localhost:3000"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)
app.options("*", cors())

// Session Configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: true,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 3600000, // 1 hour
    },
  }),
)

// Database Setup
const db = new sqlite3.Database("./meetings.db")

// Initialize database
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT UNIQUE,
    topic TEXT,
    start_time TEXT,
    status TEXT DEFAULT 'pending',
    mom_content TEXT,
    transcript TEXT,
    audio_file_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS meeting_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    email TEXT,
    name TEXT,
    FOREIGN KEY(meeting_id) REFERENCES meetings(meeting_id)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS processed_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE,
    meeting_id TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
})

// Configuration
const ZOOM_CONFIG = {
  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
  redirectUri: process.env.ZOOM_REDIRECT_URI || "http://localhost:3000/auth/zoom/callback",
  authUrl: "https://zoom.us/oauth/authorize",
  tokenUrl: "https://zoom.us/oauth/token",
  scopes: ["meeting:read", 
    "recording:read", 
    "user:read",
    "report:read:list_meeting_participants:admin"],
}

const OUTLOOK_CONFIG = {
  clientId: process.env.OUTLOOK_CLIENT_ID,
  clientSecret: process.env.OUTLOOK_CLIENT_SECRET,
  redirectUri: process.env.OUTLOOK_REDIRECT_URI || "http://localhost:3000/auth/outlook/callback",
  authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: ["https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read"],
}

// Local audio files configuration
const LOCAL_AUDIO_CONFIG = {
  watchDirectory: process.env.ZOOM_RECORDINGS_PATH || "C:\\Users\\ganes\\Documents\\Zoom",
  supportedFormats: [".m4a", ".mp3", ".wav", ".mp4", ".mov"],
}

// Initialize services
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })

// Token Storage
let tokenStore = {}
let outlookTokenStore = {}

// Authentication Status Tracking
let authStatus = {
  zoomAuthenticated: false,
  outlookAuthenticated: false,
  systemInitialized: false,
}

// File watcher instance
let fileWatcher = null
let cronJob = null

// Custom Graph Authentication Provider
class CustomAuthProvider {
  async getAccessToken() {
    if (!outlookTokenStore.accessToken) {
      throw new Error("No Outlook access token available")
    }
    if (Date.now() >= outlookTokenStore.expiresAt) {
      await refreshOutlookToken()
    }
    return outlookTokenStore.accessToken
  }
}

const graphClient = Client.initWithMiddleware({
  authProvider: new CustomAuthProvider(),
})

// Utility Functions
async function refreshOutlookToken() {
  try {
    const response = await axios.post(
      OUTLOOK_CONFIG.tokenUrl,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: outlookTokenStore.refreshToken,
        client_id: OUTLOOK_CONFIG.clientId,
        client_secret: OUTLOOK_CONFIG.clientSecret,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    )
    const { access_token, refresh_token, expires_in } = response.data
    outlookTokenStore = {
      accessToken: access_token,
      refreshToken: refresh_token || outlookTokenStore.refreshToken,
      expiresAt: Date.now() + expires_in * 1000,
    }
  } catch (error) {
    console.error("Outlook token refresh failed:", error.response?.data || error.message)
    throw error
  }
}

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
})

// Audio Transcription Function using Groq
async function transcribeAudio(audioFilePath) {
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("Groq API key not configured")
    }

    console.log(`Starting transcription for: ${audioFilePath}`)

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: "distil-whisper-large-v3-en",
      response_format: "verbose_json",
    })

    console.log("Transcription completed successfully")
    return transcription.text
  } catch (error) {
    console.error("Groq transcription failed:", error.message)
    throw error
  }
}

// Generate MOM from transcript
async function generateMOM(transcript, meetingTopic = "Meeting") {
  try {
    const prompt = `Create a professional Minutes of Meeting (MOM) with the following sections:
1. Meeting Details
2. Attendees (extract from transcript if mentioned)
3. Key Discussion Points
4. Decisions Made
5. Action Items (with responsible persons if mentioned)
6. Next Steps
7. Next Meeting (if mentioned)

Meeting Topic: ${meetingTopic}
Meeting Transcript:
${transcript}

Format the output in clean HTML for email.`

    const result = await model.generateContent(prompt)
    const response = await result.response
    return response.text()
  } catch (error) {
    console.error("MOM generation failed:", error)
    throw error
  }
}

// Send MOM via Outlook
async function sendMOMEmail(participants, momContent, meetingTopic, meetingDate) {
  if (!outlookTokenStore.accessToken) {
    throw new Error("Not authenticated with Outlook")
  }

  const emailPromises = participants.map(async (participant) => {
    if (participant.email) {
      const emailBody = {
        message: {
          subject: `Minutes of Meeting - ${meetingTopic}`,
          body: {
            contentType: "HTML",
            content: `
              <h2>Minutes of Meeting</h2>
              <p><strong>Meeting:</strong> ${meetingTopic}</p>
              <p><strong>Date:</strong> ${meetingDate}</p>
              <hr>
              ${momContent}
              <hr>
              <p><em>This email was automatically generated from the meeting transcript.</em></p>
            `,
          },
          toRecipients: [
            {
              emailAddress: {
                address: participant.email,
                name: participant.name,
              },
            },
          ],
        },
      }

      try {
        await graphClient.api("/me/sendMail").post(emailBody)
        console.log(`Email sent to ${participant.email}`)
      } catch (emailError) {
        console.error(`Failed to send email to ${participant.email}:`, emailError)
        throw emailError
      }
    }
  })

  await Promise.all(emailPromises)
}

// Process audio file and generate MOM
async function processAudioFile(audioFilePath, meetingId = null) {
  // Only process if both services are authenticated
  if (!authStatus.zoomAuthenticated || !authStatus.outlookAuthenticated) {
    console.log("Skipping audio processing - authentication not complete")
    return
  }

  try {
    console.log(`Processing audio file: ${audioFilePath}`)

    // Check if file already processed
    const existingFile = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM processed_files WHERE file_path = ?", [audioFilePath], (err, row) => {
        if (err) reject(err)
        else resolve(row)
      })
    })

    if (existingFile) {
      console.log(`File already processed: ${audioFilePath}`)
      return
    }

    // Transcribe audio
    console.log("Transcribing audio...")
    const transcript = await transcribeAudio(audioFilePath)

    if (!transcript || transcript.trim().length === 0) {
      console.log("No transcript generated, skipping...")
      return
    }

    // Extract meeting info from file path
    const fileName = path.basename(audioFilePath)
    const meetingTopic = extractMeetingTopicFromPath(audioFilePath) || "Zoom Meeting"
    const meetingDate = extractDateFromPath(audioFilePath) || new Date().toISOString()

    // Generate MOM
    console.log("Generating MOM...")
    const momContent = await generateMOM(transcript, meetingTopic)

    // Create or update meeting record
    const finalMeetingId = meetingId || `local_${Date.now()}`

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO meetings 
         (meeting_id, topic, start_time, status, mom_content, transcript, audio_file_path) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [finalMeetingId, meetingTopic, meetingDate, "processed", momContent, transcript, audioFilePath],
        (err) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })

    // Get participants (if available from Zoom API)
    let participants = []
    if (meetingId && tokenStore.accessToken) {
      try {
        participants = await getZoomMeetingParticipants(meetingId)
      } catch (error) {
        console.log("Could not fetch Zoom participants, using default")
      }
    }

    // If no participants from Zoom, use a default or extract from transcript
    if (participants.length === 0) {
      participants = [{ email: process.env.DEFAULT_EMAIL || "user@example.com", name: "Meeting Organizer" }]
    }

    // Send MOM email
    if (outlookTokenStore.accessToken) {
      console.log("Sending MOM email...")
      await sendMOMEmail(participants, momContent, meetingTopic, new Date(meetingDate).toLocaleString())
    }

    // Mark file as processed
    await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO processed_files (file_path, meeting_id) VALUES (?, ?)",
        [audioFilePath, finalMeetingId],
        (err) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })

    console.log(`Successfully processed: ${audioFilePath}`)
  } catch (error) {
    console.error(`Error processing audio file ${audioFilePath}:`, error)
  }
}

// Extract meeting topic from file path
function extractMeetingTopicFromPath(filePath) {
  const pathParts = filePath.split(path.sep)
  for (const part of pathParts) {
    if (part.includes("Zoom Meeting") || part.includes("Meeting")) {
      return part.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}\.\d{2}\.\d{2}\s+/, "")
    }
  }
  return null
}

// Extract date from file path
function extractDateFromPath(filePath) {
  const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/)
  if (dateMatch) {
    return new Date(dateMatch[1]).toISOString()
  }
  return null
}

// Get Zoom meeting participants
async function getZoomMeetingParticipants(meetingId) {
  try {
    const participantsResponse = await axios.get(`https://api.zoom.us/v2/report/meetings/${meetingId}/participants`, {
      headers: {
        Authorization: `Bearer ${tokenStore.accessToken}`,
      },
    })

    return (participantsResponse.data.participants || [])
      .map((p) => ({
        name: p.name,
        email: p.user_email,
      }))
      .filter((p) => p.email)
  } catch (error) {
    console.error("Error fetching Zoom participants:", error)
    return []
  }
}

// File watcher for local audio files
function setupFileWatcher() {
  if (!fs.existsSync(LOCAL_AUDIO_CONFIG.watchDirectory)) {
    console.log(`Watch directory does not exist: ${LOCAL_AUDIO_CONFIG.watchDirectory}`)
    return
  }

  console.log(`Setting up file watcher for: ${LOCAL_AUDIO_CONFIG.watchDirectory}`)

  fileWatcher = chokidar.watch(LOCAL_AUDIO_CONFIG.watchDirectory, {
    ignored: /^\./,
    persistent: true,
    depth: 10,
  })

  fileWatcher.on("add", (filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    if (LOCAL_AUDIO_CONFIG.supportedFormats.includes(ext)) {
      console.log(`New audio file detected: ${filePath}`)
      // Wait a bit to ensure file is fully written
      setTimeout(() => {
        processAudioFile(filePath)
      }, 5000)
    }
  })

  fileWatcher.on("error", (error) => {
    console.error("File watcher error:", error)
  })

  console.log("File watcher setup completed")
}

// Scan existing files on startup
async function scanExistingFiles() {
  if (!fs.existsSync(LOCAL_AUDIO_CONFIG.watchDirectory)) {
    console.log("Watch directory does not exist, skipping file scan")
    return
  }

  console.log("Scanning for existing audio files...")

  function scanDirectory(dir) {
    const files = fs.readdirSync(dir)

    for (const file of files) {
      const filePath = path.join(dir, file)
      const stat = fs.statSync(filePath)

      if (stat.isDirectory()) {
        scanDirectory(filePath)
      } else {
        const ext = path.extname(file).toLowerCase()
        if (LOCAL_AUDIO_CONFIG.supportedFormats.includes(ext)) {
          // Check if file is from today or recent
          const fileDate = stat.mtime
          const today = new Date()
          const daysDiff = (today - fileDate) / (1000 * 60 * 60 * 24)

          if (daysDiff <= 7) {
            // Process files from last 7 days
            console.log(`Found recent audio file: ${filePath}`)
            processAudioFile(filePath)
          }
        }
      }
    }
  }

  scanDirectory(LOCAL_AUDIO_CONFIG.watchDirectory)
  console.log("File scan completed")
}

// Auto-fetch today's meetings and process them
async function autoProcessTodaysMeetings() {
  if (!tokenStore.accessToken) {
    console.log("Zoom not authenticated, skipping auto-processing")
    return
  }

  try {
    console.log("Auto-processing today's meetings...")

    const today = new Date().toISOString().split("T")[0]
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0]

    const meetingsResponse = await axios.get("https://api.zoom.us/v2/users/me/meetings", {
      headers: {
        Authorization: `Bearer ${tokenStore.accessToken}`,
      },
      params: {
        type: "scheduled",
        from: today,
        to: tomorrow,
      },
    })

    const meetings = meetingsResponse.data.meetings || []

    for (const meeting of meetings) {
      // Store meeting info
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT OR IGNORE INTO meetings (meeting_id, topic, start_time) VALUES (?, ?, ?)",
          [meeting.id, meeting.topic, meeting.start_time],
          (err) => {
            if (err) reject(err)
            else resolve()
          },
        )
      })

      // Get and store participants
      try {
        const participants = await getZoomMeetingParticipants(meeting.id)
        for (const participant of participants) {
          await new Promise((resolve, reject) => {
            db.run(
              "INSERT OR REPLACE INTO meeting_participants (meeting_id, email, name) VALUES (?, ?, ?)",
              [meeting.id, participant.email, participant.name],
              (err) => {
                if (err) reject(err)
                else resolve()
              },
            )
          })
        }
      } catch (error) {
        console.log(`Could not fetch participants for meeting ${meeting.id}`)
      }
    }

    console.log(`Processed ${meetings.length} meetings for today`)
  } catch (error) {
    console.error("Error auto-processing meetings:", error)
  }
}

// Initialize system after both authentications are complete
function initializeSystem() {
  if (authStatus.zoomAuthenticated && authStatus.outlookAuthenticated && !authStatus.systemInitialized) {
    console.log("🚀 Both services authenticated - Initializing system...")
    
    authStatus.systemInitialized = true

    // Setup file watcher
    setupFileWatcher()

    // Scan existing files
    setTimeout(() => {
      scanExistingFiles()
    }, 2000)

    // Process today's meetings
    setTimeout(() => {
      autoProcessTodaysMeetings()
    }, 4000)

    // Setup cron job for hourly processing
    if (!cronJob) {
      cronJob = cron.schedule("0 * * * *", () => {
        console.log("Running scheduled meeting processing...")
        autoProcessTodaysMeetings()
      })
      console.log("Scheduled hourly processing enabled")
    }

    console.log("✅ System initialization completed!")
  }
}

// Check authentication status
function checkAuthStatus() {
  console.log("Authentication Status:")
  console.log(`- Zoom: ${authStatus.zoomAuthenticated ? '✅' : '❌'}`)
  console.log(`- Outlook: ${authStatus.outlookAuthenticated ? '✅' : '❌'}`)
  console.log(`- System Initialized: ${authStatus.systemInitialized ? '✅' : '❌'}`)
}

// OAuth Endpoints
app.get("/auth/zoom", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex")
  req.session.oauthState = state
  req.session.save((err) => {
    if (err) {
      console.error("Session save error:", err)
      return res.status(500).send("Session error")
    }
    const authUrl = new URL(ZOOM_CONFIG.authUrl)
    authUrl.searchParams.append("response_type", "code")
    authUrl.searchParams.append("client_id", ZOOM_CONFIG.clientId)
    authUrl.searchParams.append("redirect_uri", ZOOM_CONFIG.redirectUri)
    authUrl.searchParams.append("state", state)
    authUrl.searchParams.append("scope", ZOOM_CONFIG.scopes.join(" "))
    res.redirect(authUrl.toString())
  })
})

app.get("/auth/zoom/callback", async (req, res) => {
  const { code } = req.query
  try {
    const authHeader = `Basic ${Buffer.from(`${ZOOM_CONFIG.clientId}:${ZOOM_CONFIG.clientSecret}`).toString("base64")}`
    const tokenResponse = await axios.post(
      ZOOM_CONFIG.tokenUrl,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ZOOM_CONFIG.redirectUri,
      }),
      {
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    )
    const { access_token, refresh_token, expires_in } = tokenResponse.data
    tokenStore = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    }

    // Mark Zoom as authenticated
    authStatus.zoomAuthenticated = true
    console.log("✅ Zoom authentication successful!")
    console.log(tokenResponse.data)

    // Check if we can initialize the system
    initializeSystem()

    res.json({
      status: "Zoom Authenticated",
      expires_in: `${expires_in} seconds`,
      next_step: authStatus.outlookAuthenticated ? "System Ready!" : "Please authenticate with Outlook",
    })
  } catch (error) {
    console.error("Zoom OAuth failed:", error.response?.data || error.message)
    res.status(500).json({
      error: "Zoom OAuth failed",
      details: error.response?.data || error.message,
    })
  }
})

app.get("/auth/outlook", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex")
  req.session.outlookState = state
  req.session.save((err) => {
    if (err) {
      console.error("Session save error:", err)
      return res.status(500).send("Session error")
    }
    const authUrl = new URL(OUTLOOK_CONFIG.authUrl)
    authUrl.searchParams.append("response_type", "code")
    authUrl.searchParams.append("client_id", OUTLOOK_CONFIG.clientId)
    authUrl.searchParams.append("redirect_uri", OUTLOOK_CONFIG.redirectUri)
    authUrl.searchParams.append("state", state)
    authUrl.searchParams.append("scope", OUTLOOK_CONFIG.scopes.join(" "))
    res.redirect(authUrl.toString())
  })
})

app.get("/auth/outlook/callback", async (req, res) => {
  const { code, state } = req.query
  if (state !== req.session.outlookState) {
    return res.status(400).json({ error: "Invalid state parameter" })
  }
  try {
    const tokenResponse = await axios.post(
      OUTLOOK_CONFIG.tokenUrl,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: OUTLOOK_CONFIG.redirectUri,
        client_id: OUTLOOK_CONFIG.clientId,
        client_secret: OUTLOOK_CONFIG.clientSecret,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    )
    console.log("Outlook OAuth response:", tokenResponse.data)
    const { access_token, refresh_token, expires_in } = tokenResponse.data
    outlookTokenStore = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    }

    // Mark Outlook as authenticated
    authStatus.outlookAuthenticated = true
    console.log("✅ Outlook authentication successful!")

    // Check if we can initialize the system
    initializeSystem()

    res.json({
      status: "Outlook Authenticated",
      expires_in: `${expires_in} seconds`,
      next_step: authStatus.zoomAuthenticated ? "System Ready!" : "Please authenticate with Zoom",
    })
  } catch (error) {
    console.error("Outlook OAuth failed:", error.response?.data || error.message)
    res.status(500).json({
      error: "Outlook OAuth failed",
      details: error.response?.data || error.message,
    })
  }
})

// API Endpoints
app.post("/process-audio-file", async (req, res) => {
  try {
    const { filePath, meetingId } = req.body

    if (!filePath) {
      return res.status(400).json({ error: "File path is required" })
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Audio file not found" })
    }

    if (!authStatus.zoomAuthenticated || !authStatus.outlookAuthenticated) {
      return res.status(401).json({ 
        error: "Authentication required", 
        details: "Both Zoom and Outlook authentication required before processing files" 
      })
    }

    await processAudioFile(filePath, meetingId)

    res.json({
      message: "Audio file processed successfully",
      filePath,
    })
  } catch (error) {
    console.error("Error processing audio file:", error)
    res.status(500).json({
      error: "Failed to process audio file",
      details: error.message,
    })
  }
})

app.get("/processed-meetings", (req, res) => {
  db.all("SELECT * FROM meetings ORDER BY start_time DESC LIMIT 50", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Database error" })
    }
    res.json(rows)
  })
})

app.get("/auth-status", (req, res) => {
  res.json({
    zoom_authenticated: authStatus.zoomAuthenticated,
    outlook_authenticated: authStatus.outlookAuthenticated,
    system_initialized: authStatus.systemInitialized,
    ready_for_processing: authStatus.zoomAuthenticated && authStatus.outlookAuthenticated,
  })
})

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    zoom: ZOOM_CONFIG.clientId ? "Configured" : "Not configured",
    outlook: OUTLOOK_CONFIG.clientId ? "Configured" : "Not configured",
    gemini: process.env.GEMINI_API_KEY ? "Configured" : "Not configured",
    groq: process.env.GROQ_API_KEY ? "Configured" : "Not configured",
    zoom_oauth_ready: authStatus.zoomAuthenticated,
    outlook_oauth_ready: authStatus.outlookAuthenticated,
    system_initialized: authStatus.systemInitialized,
    watch_directory: LOCAL_AUDIO_CONFIG.watchDirectory,
    watch_directory_exists: fs.existsSync(LOCAL_AUDIO_CONFIG.watchDirectory),
  })
})

// Start server
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
  console.log(`Zoom OAuth configured: ${!!ZOOM_CONFIG.clientId}`)
  console.log(`Outlook OAuth configured: ${!!OUTLOOK_CONFIG.clientId}`)
  console.log(`Gemini API configured: ${!!process.env.GEMINI_API_KEY}`)
  console.log(`Groq API configured: ${!!process.env.GROQ_API_KEY}`)
  console.log(`Watch directory: ${LOCAL_AUDIO_CONFIG.watchDirectory}`)
  console.log("\n📋 Authentication Required:")
  console.log("1. Visit /auth/zoom to authenticate with Zoom")
  console.log("2. Visit /auth/outlook to authenticate with Outlook")
  console.log("3. System will automatically start processing after both authentications")
  
  checkAuthStatus()
})
