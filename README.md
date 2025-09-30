
# Virtually Try Clothes on with Gemini Nano Banana Via RCS

This Node.js project lets users send a selfie and a clothing image via RCS, then generates a virtual try-on result using Google's Gemini AI and sends it back as an RCS Rich Card with Vonage Messages API.

## Installation

Clone the repository and install dependencies:

```bash
npm install
```

## Usage

Start the server:

```bash
npm start
```

### RCS Conversation Flow

1. User sends a selfie via RCS (with a message like "selfie" or "me")
2. User sends a clothing image via RCS (with a message like "dress" or "shirt")
3. The server receives both images, runs the try-on AI, and sends the result back as an RCS Rich Card

## Output

Each user session generates a try-on image saved in `/Pictures` and sent back to the user as an RCS Rich Card.

## File Structure

```
blog-messages_rcs_nodejs-try_on"
├── src/
│   └── index.js              # Main application file
}   └── vonage.js
├── Pictures/
│   ├── me.png              # Default user photo (optional for direct API)
│   └── sample-clothing.png # Sample clothing image
├── package.json
├── .gitignore
└── README.md
```
