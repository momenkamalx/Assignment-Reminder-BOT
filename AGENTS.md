You are an experienced TypeScript engineer. Build a WhatsApp Assignment Reminder Bot for university students inside the current project folder.

I am a beginner, so handle project setup, file creation, dependencies, and testing. Explain the final results clearly.

## Technology
- Node.js + TypeScript
- Baileys (WhiskeySockets)
- SQLite database
- Vitest for testing
- Free deployment target: Oracle Cloud Always Free
- No paid APIs or services

## Main functionality

The bot works inside existing WhatsApp university groups.

### 1. Assignment detection
- Monitor only explicitly authorized WhatsApp groups.
- Each group has its own authorized student leader.
- Detect assignment announcements only from that leader.
- Recognize Arabic keywords: واجب، تسليم، مشروع.
- Recognize English equivalents: assignment, deadline, project, due.
- Support Sudanese Arabic and mixed Arabic-English announcements.
- Ignore ordinary conversations and messages from other students.

### 2. Multiple assignments
One announcement may contain several different assignments.

Extract each separately:
- Subject/course
- Assignment name (if provided)
- Description (optional)
- Deadline date and time
- Submission method (SUST Moodle, email, Google Forms, Google Drive, in person, custom)
- Submission link or email address, if available

Never invent missing information. Clearly identify ambiguous or missing deadlines.

### 3. Admin confirmation
- Reply to the original leader announcement with a numbered preview of detected assignments.
- Ask: هل تريد تسجيل التكليفات؟
- Allow authorized admins to confirm by replying to the bot's specific confirmation message with نعم، يس، yes, or y.
- Allow rejection using لا or no.
- Support editing individual detected assignments before approval.
- If deadlines are ambiguous, require corrections before scheduling.
- After confirmation, save assignments in SQLite and send a success message.
- Immediately invalidate any other pending confirmations related to the same original announcement.
- Prevent duplicate registrations using database constraints and transactions.
- Handle simultaneous approval by multiple admins safely.

### 4. Automatic reminders
- Send a reminder 24 hours before each deadline.
- Optionally support reminders 3 days and 2 hours before.
- Include course, assignment name, exact deadline, submission destination and link.
- Send reminders to the correct group only.
- Investigate genuine WhatsApp @all support in Baileys. Do not assume that writing @all is equivalent to tagging everyone.
- If native @all is unsupported, provide an optional individual-mentions alternative.
- Prevent duplicate reminder delivery as far as practical.
- Handle retries, reconnections, and missed reminders after downtime.

### 5. Multiple groups
- Each group has separate assignments, leader, admins and reminder settings.
- Support configuring and managing authorized groups.
- Never mix assignments or permissions across groups.

### 6. Commands
- !list — list upcoming assignments
- !edit — modify assignment (admins only)
- !delete — remove assignment (admins only)
- !help — show commands
- Support confirmed deadline changes and assignment cancellations.

### 7. Reliability and security
- Store WhatsApp authentication securely outside Git.
- Use .env.example and .gitignore.
- Use UTC for internal timestamps, with Africa/Khartoum as the default timezone.
- Store original WhatsApp message IDs.
- Minimize message collection and logging.
- Keep the Baileys adapter separate from assignment parsing and business logic.
- Document unofficial WhatsApp automation risks.
- Add database migrations, tests and useful error logging.

## Development stages

Stage 1: Project foundation, SQLite, assignment extraction, confirmation workflow, mock WhatsApp adapter, and tests.

Stage 2: Real Baileys connection and group configuration.

Stage 3: Reliable scheduling, reminders, recovery, updates, and mentions.

Stage 4: Oracle Cloud deployment, systemd service, backups, and operational documentation.

IMPORTANT:
Complete Stage 1 only for now.

Do not connect a real WhatsApp account, deploy to Oracle Cloud, or use paid APIs.

Create the necessary project files, install dependencies, run automated tests, and fix errors.

At the end, explain:
1. What was implemented.
2. What tests passed.
3. What is incomplete.
4. How I can test Stage 1 locally.