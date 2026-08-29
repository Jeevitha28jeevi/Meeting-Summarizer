# Meetly — Corporate Meeting Summarizer mini project

A full-stack mini project built with:

- HTML5
- Tailwind CSS CDN utilities + custom CSS
- Vanilla JavaScript
- Node.js + Express
- MongoDB Atlas + Mongoose
- JWT authentication and bcrypt password hashing
- Luxon for IANA timezone conversion
- SheetJS (`xlsx`) for Excel export
- Node Cron for automatic cancellation
- Chart.js for visual charts

## Features included

- Employee registration and admin/employee login
- Password visibility eye button
- Role-based access control
- Admin meeting scheduling
- Employee meeting requests with a centralized admin approval queue
- Admin room assignment before approval
- Approve or reject employee requests
- Select individual employees or everyone with checkboxes
- Live meeting and employee filter bars
- IANA timezone scheduling converted and stored in UTC
- Local-time and UTC-time display
- Conflict validation before a meeting is created
- Employee response: attending or absent
- Admin response controls: pending, attending, absent, lobby busy
- Automatic cancellation when no participant is attending after the grace period
- Manual “Auto-cancel now” button for testing
- Excel meeting export
- Activity audit log
- Employee performance ratings from 0.0 to 5.0
- Optional post-meeting summary/key decisions when the admin marks a meeting completed
- Visual status and attendance charts
- Dark-mode toggle
- Responsive layout for mobile and desktop

## 1. Prerequisites

Install these first:

1. **Node.js 18 or newer**: https://nodejs.org/en/download
2. A **MongoDB Atlas** account: https://www.mongodb.com/atlas/database
3. A modern browser such as Chrome, Edge or Firefox

Check Node.js:

```bash
node --version
npm --version
```

## 2. Install the project

Open a terminal in the project folder:

```bash
cd corporate-meeting-summarizer
npm install
```

The `npm install` command installs the backend packages from `package.json`:

| Package | Purpose |
|---|---|
| `express` | HTTP server and REST API |
| `mongoose` | MongoDB Atlas connection and data models |
| `dotenv` | Reads `.env` configuration |
| `bcryptjs` | Hashes and verifies passwords |
| `jsonwebtoken` | Login tokens and protected routes |
| `luxon` | IANA timezone parsing and UTC conversion |
| `xlsx` | Creates `.xlsx` Excel files |
| `node-cron` | Runs the auto-cancel job every minute |
| `helmet` | Basic HTTP security headers |
| `morgan` | Request logging |
| `nodemon` | Restarts the server during development |

Tailwind CSS and Chart.js are loaded from CDN in `public/index.html`. An internet connection is needed for their enhanced styling/chart rendering. The custom CSS still provides the main layout if a CDN is temporarily unavailable.

## 3. Create a MongoDB Atlas database

1. Open https://cloud.mongodb.com/
2. Create an Atlas project, for example `Meetly`.
3. Create a free-tier cluster.
4. Open **Database Access** → **Add New Database User**.
   - Choose password authentication.
   - Create a username and strong password.
   - Give the user read/write access to the project database.
5. Open **Network Access** → **Add IP Address**.
   - For local development, add your current IP address.
   - `0.0.0.0/0` permits all IP addresses and is convenient for testing, but it is not recommended for production.
6. Open the cluster → **Connect** → **Drivers**.
7. Select **Node.js** and copy the connection string. It looks like:

```text
mongodb+srv://<db_user>:<db_password>@cluster0.xxxxx.mongodb.net/corporate_meetings?retryWrites=true&w=majority&appName=Meetly
```

8. If your password contains characters such as `@`, `:`, `/`, `?`, or `#`, URL-encode it before placing it in the connection string. You can use `encodeURIComponent()` in a Node.js console.

## 4. Configure the environment

Copy `.env.example` to `.env`:

macOS/Linux/Git Bash:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```env
PORT=3000
MONGO_URI=mongodb+srv://meetly_user:YOUR_URL_ENCODED_PASSWORD@cluster0.xxxxx.mongodb.net/corporate_meetings?retryWrites=true&w=majority&appName=Meetly
JWT_SECRET=put-a-long-random-secret-here
AUTO_CANCEL_GRACE_MINUTES=5
```

Important:

- Do not commit `.env` to Git. It is already ignored in `.gitignore`.
- The database name in this example is `corporate_meetings`.
- On the first connection to an empty database, the server creates three demo accounts.
- If `MONGO_URI` is not present, the project starts in temporary in-memory demo mode. Data disappears when the server stops. This makes it possible to preview the UI before configuring Atlas.

## 5. Run the application

Development mode, with automatic restart:

```bash
npm run dev
```

Production-style local run:

```bash
npm start
```

### Exact local application link

Open this in your browser:

**http://localhost:3000**

Health check:

**http://localhost:3000/api/health**

When the server is running, the terminal prints the same links. The API and frontend use the same port, so no separate frontend server is required.

## 6. Demo login accounts

If the database is empty, the server seeds these accounts:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@example.com` | `Admin@123` |
| Employee | `employee@example.com` | `Employee@123` |
| Employee | `employee2@example.com` | `Employee@123` |

Public registration always creates an employee. The admin can create users with the protected `POST /api/users` API route.

## 7. How to test the main workflow

1. Sign in as an employee and open **Meetings**.
2. Use **Request a meeting** to enter a title, preferred time, participants and an optional room preference.
3. Submit the request, then sign out.
4. Sign in as the admin. The request appears in **Pending meeting requests** on the Dashboard.
5. Enter a room and click **Approve request**, or reject it with a reason. Approval creates the official meeting.
6. Open **Meetings** to see the approved room and respond to attendance.
7. To test direct admin scheduling, select a future date/time and choose a timezone such as `Asia/Kolkata`.
8. Tick multiple employees or click **Select everyone**, then click **Schedule meeting**.
9. Open a second browser/incognito window and sign in as `employee@example.com`.
10. The employee can click **Attending** or **Absent**.
11. Back in the admin window, the participant chip shows each attendance status.
12. Try scheduling another overlapping meeting for the same employee. The server returns a conflict-validation message and does not create it.
13. Use **Excel** to download `corporate-meetings.xlsx`.
14. Use **Auto-cancel now** to run the cancellation job manually. The background cron also runs every minute.
15. Open **Employees** to update a performance rating.
16. Open **Audit log** to see logins, meeting creation, requests, approvals, responses, rating updates and automation events.
17. Toggle the moon/sun icon for dark mode.

## 8. UTC and timezone design

The meeting form accepts a local date/time plus an IANA timezone, for example:

```text
Local input: 2026-08-20 10:00
Timezone: Asia/Kolkata
Stored value: 2026-08-20T04:30:00.000Z
```

The database always stores `startAt` and `endAt` as UTC `Date` values. The UI shows both the employee's local timezone and UTC. This prevents members in India, Europe and the United States from interpreting the same meeting differently.

Use IANA names such as:

- `UTC`
- `Asia/Kolkata`
- `Europe/London`
- `America/New_York`
- `America/Los_Angeles`
- `Australia/Sydney`

## 9. Main API routes

All routes except registration, login and health require:

```http
Authorization: Bearer YOUR_JWT_TOKEN
```

| Method | Route | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Register an employee |
| `POST` | `/api/auth/login` | Public | Login |
| `GET` | `/api/auth/me` | Login | Current user |
| `GET` | `/api/users` | Admin | List users |
| `POST` | `/api/users` | Admin | Create a user |
| `PATCH` | `/api/users/:id` | Admin | Update employee/rating |
| `GET` | `/api/meetings` | Login | List visible meetings |
| `POST` | `/api/meeting-requests` | Employee | Submit a meeting request |
| `GET` | `/api/meeting-requests` | Login | List own or all requests |
| `PATCH` | `/api/meeting-requests/:id/approve` | Admin | Assign a room and create the official meeting |
| `PATCH` | `/api/meeting-requests/:id/reject` | Admin | Reject a pending request |
| `POST` | `/api/meetings` | Admin | Schedule a meeting directly |
| `PATCH` | `/api/meetings/:id/participants/:userId/status` | Owner/Admin | Update attendance |
| `PATCH` | `/api/meetings/:id/status` | Admin | Complete or cancel a meeting |
| `POST` | `/api/automation/run` | Admin | Run auto-cancel immediately |
| `GET` | `/api/analytics` | Login | Dashboard chart data |
| `GET` | `/api/audit-logs` | Admin | Audit history |
| `GET` | `/api/export/meetings.xlsx` | Admin | Excel export |

## 10. MongoDB Atlas backup from the command line

For a full BSON backup, install MongoDB Database Tools and run:

```bash
mongodump --uri="YOUR_MONGO_URI" --out="./backups/$(date +%Y-%m-%d)"
```

On Windows PowerShell, use a fixed folder name or a PowerShell date expression. Never put your Atlas password in source code or publish a backup containing sensitive data.

## 11. Suggested production improvements

This is a mini-project starter. Before production, add:

- HttpOnly secure cookies instead of localStorage JWTs
- CSRF protection and rate limiting
- Email verification, password reset and MFA
- An administrator UI for creating employee accounts
- A real queue/worker for auto-cancellation rather than an in-process cron job
- Pagination and indexes for large meeting/audit collections
- Encrypted backup storage and a retention policy
- Server-side validation using a schema library such as Zod or Joi
- A dedicated meeting-summary/AI transcription service if “summarizer” should process transcripts or recordings
