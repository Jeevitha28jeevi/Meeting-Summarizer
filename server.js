const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const helmet = require('helmet');
const morgan = require('morgan');
const { DateTime } = require('luxon');
const cron = require('node-cron');
const XLSX = require('xlsx');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {
  // Ignore DNS setServers error in restricted serverless or custom network environments
}

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-development-secret';
const AUTO_CANCEL_GRACE_MINUTES = Number(process.env.AUTO_CANCEL_GRACE_MINUTES || 5);

app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
    timezone: { type: String, default: 'UTC' },
    department: { type: String, default: 'General' },
    performanceRating: { type: Number, min: 0, max: 5, default: 0 },
    active: { type: Boolean, default: true },
    lastLoginAt: Date
  },
  { timestamps: true }
);

const participantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['pending', 'attending', 'absent', 'busy'],
      default: 'pending'
    },
    absenceReason: { type: String, default: '' },
    respondedAt: Date
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    summary: { type: String, default: '' },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, default: 'UTC' },
    room: { type: String, default: '' },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingRequest', default: null },
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    participants: { type: [participantSchema], default: [] },
    status: {
      type: String,
      enum: ['scheduled', 'completed', 'cancelled'],
      default: 'scheduled'
    },
    cancellationReason: { type: String, default: '' },
    autoCancelMinutes: { type: Number, default: AUTO_CANCEL_GRACE_MINUTES }
  },
  { timestamps: true }
);

const meetingRequestSchema = new mongoose.Schema(
  {
    requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    agenda: { type: String, default: '' },
    requestedStartAt: { type: Date, required: true },
    requestedEndAt: { type: Date, required: true },
    timezone: { type: String, default: 'UTC' },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    roomPreference: { type: String, default: '' },
    assignedRoom: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejectionReason: { type: String, default: '' },
    adminNote: { type: String, default: '' },
    approvedMeeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: Date
  },
  { timestamps: true }
);

const auditSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

const UserModel = mongoose.model('User', userSchema);
const MeetingModel = mongoose.model('Meeting', meetingSchema);
const MeetingRequestModel = mongoose.model('MeetingRequest', meetingRequestSchema);
const AuditModel = mongoose.model('AuditLog', auditSchema);

let dbMode = 'memory-demo';
const memory = { users: [], meetings: [], meetingRequests: [], auditLogs: [] };

function newId() {
  return crypto.randomUUID();
}

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value._id || value.id || value);
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateIso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function safeUser(user) {
  if (!user) return null;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    id: idOf(plain),
    name: plain.name,
    email: plain.email,
    role: plain.role,
    timezone: plain.timezone || 'UTC',
    department: plain.department || 'General',
    performanceRating: Number(plain.performanceRating || 0),
    active: plain.active !== false,
    lastLoginAt: dateIso(plain.lastLoginAt),
    createdAt: dateIso(plain.createdAt)
  };
}

function getParticipantUserId(participant) {
  return idOf(participant && participant.user);
}

function userForParticipant(participant, usersById) {
  const participantUser = participant && participant.user;
  if (participantUser && typeof participantUser === 'object' && (participantUser.email || participantUser.name)) {
    return safeUser(participantUser);
  }
  return safeUser(usersById.get(getParticipantUserId(participant)));
}

function meetingDTO(meeting, usersById) {
  const plain = typeof meeting.toObject === 'function' ? meeting.toObject() : meeting;
  const organizerId = idOf(plain.organizer && typeof plain.organizer === 'object' ? plain.organizer : plain.organizer);
  const participants = (plain.participants || []).map((participant) => {
    const pUserId = getParticipantUserId(participant);
    const isOrganizer = pUserId && pUserId === organizerId;
    let status = participant.status || 'pending';
    if (!isOrganizer && !participant.respondedAt && status === 'attending') {
      status = 'pending';
    }
    return {
      user: userForParticipant(participant, usersById),
      status,
      absenceReason: participant.absenceReason || participant.reason || '',
      respondedAt: dateIso(participant.respondedAt)
    };
  });
  return {
    id: idOf(plain),
    title: plain.title,
    description: plain.description || '',
    summary: plain.summary || '',
    startAt: dateIso(plain.startAt),
    endAt: dateIso(plain.endAt),
    timezone: plain.timezone || 'UTC',
    room: plain.room || '',
    requestId: idOf(plain.requestId),
    organizer: safeUser(plain.organizer && typeof plain.organizer === 'object' ? plain.organizer : usersById.get(idOf(plain.organizer))),
    participants,
    status: plain.status,
    cancellationReason: plain.cancellationReason || '',
    autoCancelMinutes: Number(plain.autoCancelMinutes || AUTO_CANCEL_GRACE_MINUTES),
    createdAt: dateIso(plain.createdAt),
    updatedAt: dateIso(plain.updatedAt)
  };
}

function meetingRequestDTO(request, usersById) {
  const plain = typeof request.toObject === 'function' ? request.toObject() : request;
  const requester = plain.requester && typeof plain.requester === 'object'
    ? safeUser(plain.requester)
    : safeUser(usersById.get(idOf(plain.requester)));
  const participants = (plain.participants || [])
    .map((participant) => {
      const user = typeof participant === 'object' ? participant : usersById.get(idOf(participant));
      return safeUser(user);
    })
    .filter(Boolean);
  const approvedBy = plain.approvedBy && typeof plain.approvedBy === 'object'
    ? safeUser(plain.approvedBy)
    : safeUser(usersById.get(idOf(plain.approvedBy)));
  return {
    id: idOf(plain),
    requester,
    title: plain.title,
    agenda: plain.agenda || '',
    requestedStartAt: dateIso(plain.requestedStartAt),
    requestedEndAt: dateIso(plain.requestedEndAt),
    timezone: plain.timezone || 'UTC',
    participants,
    roomPreference: plain.roomPreference || '',
    assignedRoom: plain.assignedRoom || '',
    status: plain.status,
    rejectionReason: plain.rejectionReason || '',
    adminNote: plain.adminNote || '',
    approvedMeetingId: idOf(plain.approvedMeeting),
    approvedBy,
    approvedAt: dateIso(plain.approvedAt),
    createdAt: dateIso(plain.createdAt),
    updatedAt: dateIso(plain.updatedAt)
  };
}

function auditDTO(audit, usersById) {
  const plain = typeof audit.toObject === 'function' ? audit.toObject() : audit;
  const actor = plain.actor && typeof plain.actor === 'object'
    ? safeUser(plain.actor)
    : safeUser(usersById.get(idOf(plain.actor)));
  return {
    id: idOf(plain),
    actor,
    action: plain.action,
    entityType: plain.entityType,
    entityId: plain.entityId || '',
    metadata: plain.metadata || {},
    createdAt: dateIso(plain.createdAt)
  };
}

function validTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function connectDatabase() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb+srv://jeevitha1128_db_user:CMPminiproject2026@cluster0.hw4ts2y.mongodb.net/myapp?retryWrites=true&w=majority&appName=Cluster0';
  if (!mongoUri) {
    console.warn('MONGO_URI or MONGODB_URI is not configured. Starting in memory demo mode. Add it to .env for MongoDB Atlas.');
    dbMode = 'memory-demo';
    await seedMemoryUsers();
    return;
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 4000,
      connectTimeoutMS: 4000
    });
    dbMode = 'mongodb-atlas';
    console.log('Connected to MongoDB Atlas.');
    await seedMongoUsers();
  } catch (error) {
    console.error('MongoDB connection failed; falling back to memory demo mode:', error.message);
    dbMode = 'memory-demo';
    await seedMemoryUsers();
  }
}

let dbPromise = null;
async function ensureDbConnected(req, res, next) {
  try {
    if (!dbPromise) {
      dbPromise = connectDatabase();
    }
    await dbPromise;
    next();
  } catch (error) {
    console.error('Error in ensureDbConnected:', error);
    dbPromise = null;
    next();
  }
}

async function seedMemoryUsers() {
  if (memory.users.length) return;
  const demoUsers = [
    {
      name: 'Asha Admin',
      email: 'admin@example.com',
      password: 'Admin@123',
      role: 'admin',
      timezone: 'Asia/Kolkata',
      department: 'Operations',
      performanceRating: 4.8
    },
    {
      name: 'Ravi Kumar',
      email: 'employee@example.com',
      password: 'Employee@123',
      role: 'employee',
      timezone: 'Asia/Kolkata',
      department: 'Engineering',
      performanceRating: 4.2
    },
    {
      name: 'Maya Chen',
      email: 'employee2@example.com',
      password: 'Employee@123',
      role: 'employee',
      timezone: 'America/New_York',
      department: 'Design',
      performanceRating: 3.9
    }
  ];
  for (const item of demoUsers) {
    memory.users.push({
      id: newId(),
      name: item.name,
      email: item.email,
      passwordHash: await bcrypt.hash(item.password, 10),
      role: item.role,
      timezone: item.timezone,
      department: item.department,
      performanceRating: item.performanceRating,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null
    });
  }
}

async function seedMongoUsers() {
  const seed = [
    ['Asha Admin', 'admin@example.com', 'Admin@123', 'admin', 'Asia/Kolkata', 'Operations', 4.8],
    ['Ravi Kumar', 'employee@example.com', 'Employee@123', 'employee', 'Asia/Kolkata', 'Engineering', 4.2],
    ['Maya Chen', 'employee2@example.com', 'Employee@123', 'employee', 'America/New_York', 'Design', 3.9]
  ];
  let added = 0;
  for (const [name, email, password, role, timezone, department, performanceRating] of seed) {
    const existing = await UserModel.findOne({ email });
    if (!existing) {
      await UserModel.create({
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role,
        timezone,
        department,
        performanceRating,
        active: true
      });
      added += 1;
    } else {
      const matches = await bcrypt.compare(password, existing.passwordHash).catch(() => false);
      if (!matches || existing.active === false) {
        existing.passwordHash = await bcrypt.hash(password, 10);
        existing.active = true;
        await existing.save();
      }
    }
  }
  if (added) console.log(`Seeded ${added} missing demo account(s) in MongoDB Atlas.`);
}

async function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (dbMode === 'mongodb-atlas') return UserModel.findOne({ email: normalized });
  return memory.users.find((user) => user.email === normalized) || null;
}

async function findUserById(id) {
  if (!id) return null;
  if (dbMode === 'mongodb-atlas') {
    if (!mongoose.isValidObjectId(id)) return null;
    return UserModel.findById(id);
  }
  return memory.users.find((user) => idOf(user) === String(id)) || null;
}

async function listUsersRaw() {
  if (dbMode === 'mongodb-atlas') return UserModel.find().sort({ name: 1 }).lean();
  return [...memory.users].sort((a, b) => a.name.localeCompare(b.name));
}

async function createUserRaw(data) {
  if (dbMode === 'mongodb-atlas') return UserModel.create(data);
  const user = {
    id: newId(),
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null
  };
  memory.users.push(user);
  return user;
}

async function updateUserRaw(id, patch) {
  if (dbMode === 'mongodb-atlas') return UserModel.findByIdAndUpdate(id, { $set: patch }, { new: true });
  const user = memory.users.find((item) => idOf(item) === String(id));
  if (!user) return null;
  Object.assign(user, patch, { updatedAt: new Date() });
  return user;
}

async function listMeetingRaw() {
  if (dbMode === 'mongodb-atlas') {
    return MeetingModel.find()
      .populate('organizer')
      .populate('participants.user')
      .sort({ startAt: 1 })
      .lean();
  }
  return [...memory.meetings].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

async function findMeetingRaw(id) {
  if (dbMode === 'mongodb-atlas') {
    if (!mongoose.isValidObjectId(id)) return null;
    return MeetingModel.findById(id).populate('organizer').populate('participants.user').lean();
  }
  return memory.meetings.find((meeting) => idOf(meeting) === String(id)) || null;
}

async function createMeetingRaw(data) {
  if (dbMode === 'mongodb-atlas') {
    const created = await MeetingModel.create(data);
    return MeetingModel.findById(created._id).populate('organizer').populate('participants.user').lean();
  }
  const meeting = {
    id: newId(),
    ...data,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  memory.meetings.push(meeting);
  return meeting;
}

async function listMeetingRequestRaw() {
  if (dbMode === 'mongodb-atlas') {
    return MeetingRequestModel.find()
      .populate('requester')
      .populate('participants')
      .populate('approvedBy')
      .sort({ createdAt: -1 })
      .lean();
  }
  return [...memory.meetingRequests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function findMeetingRequestRaw(id) {
  if (dbMode === 'mongodb-atlas') {
    if (!mongoose.isValidObjectId(id)) return null;
    return MeetingRequestModel.findById(id)
      .populate('requester')
      .populate('participants')
      .populate('approvedBy')
      .lean();
  }
  return memory.meetingRequests.find((request) => idOf(request) === String(id)) || null;
}

async function createMeetingRequestRaw(data) {
  if (dbMode === 'mongodb-atlas') {
    const created = await MeetingRequestModel.create(data);
    return MeetingRequestModel.findById(created._id)
      .populate('requester')
      .populate('participants')
      .populate('approvedBy')
      .lean();
  }
  const request = {
    id: newId(),
    ...data,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  memory.meetingRequests.push(request);
  return request;
}

async function updateMeetingRequestRaw(id, patch) {
  if (dbMode === 'mongodb-atlas') {
    return MeetingRequestModel.findByIdAndUpdate(id, { $set: patch }, { new: true })
      .populate('requester')
      .populate('participants')
      .populate('approvedBy')
      .lean();
  }
  const request = memory.meetingRequests.find((item) => idOf(item) === String(id));
  if (!request) return null;
  Object.assign(request, patch, { updatedAt: new Date() });
  return request;
}

async function updateMeetingRaw(id, patch) {
  if (dbMode === 'mongodb-atlas') {
    return MeetingModel.findByIdAndUpdate(id, { $set: patch }, { new: true })
      .populate('organizer')
      .populate('participants.user')
      .lean();
  }
  const meeting = memory.meetings.find((item) => idOf(item) === String(id));
  if (!meeting) return null;
  Object.assign(meeting, patch, { updatedAt: new Date() });
  return meeting;
}

async function updateParticipantRaw(meetingId, participantUserId, patch) {
  if (dbMode === 'mongodb-atlas') {
    const meeting = await MeetingModel.findById(meetingId);
    if (!meeting) return null;
    const participant = meeting.participants.find((item) => idOf(item.user) === String(participantUserId));
    if (!participant) return null;
    Object.assign(participant, patch);
    await meeting.save();
    return MeetingModel.findById(meetingId).populate('organizer').populate('participants.user').lean();
  }
  const meeting = memory.meetings.find((item) => idOf(item) === String(meetingId));
  if (!meeting) return null;
  const participant = meeting.participants.find((item) => getParticipantUserId(item) === String(participantUserId));
  if (!participant) return null;
  Object.assign(participant, patch);
  meeting.updatedAt = new Date();
  return meeting;
}

async function createAuditRaw(data) {
  const record = { ...data, createdAt: new Date(), updatedAt: new Date() };
  if (dbMode === 'mongodb-atlas') return AuditModel.create(data);
  memory.auditLogs.push({ id: newId(), ...record });
  return record;
}

async function listAuditRaw() {
  if (dbMode === 'mongodb-atlas') {
    return AuditModel.find().populate('actor').sort({ createdAt: -1 }).limit(500).lean();
  }
  return [...memory.auditLogs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 500);
}

async function usersMap() {
  const users = await listUsersRaw();
  return new Map(users.map((user) => [idOf(user), user]));
}

async function logAudit(actor, action, entityType, entityId, metadata = {}) {
  try {
    await createAuditRaw({
      actor: actor ? idOf(actor) : null,
      action,
      entityType,
      entityId: String(entityId || ''),
      metadata
    });
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
}

function signToken(user) {
  return jwt.sign(
    { id: idOf(user), role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

async function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentication required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.id);
    if (!user || user.active === false) return res.status(401).json({ message: 'Your account is inactive or no longer exists.' });
    req.currentUser = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.currentUser || !roles.includes(req.currentUser.role)) {
      return res.status(403).json({ message: 'You do not have permission for this action.' });
    }
    next();
  };
}

function parseSchedule(body) {
  const timezone = body.timezone || 'UTC';
  if (!validTimezone(timezone)) {
    const error = new Error('Use a valid IANA timezone such as Asia/Kolkata or America/New_York.');
    error.status = 400;
    throw error;
  }

  let start;
  let end;
  if (body.startLocal) {
    start = DateTime.fromISO(String(body.startLocal), { zone: timezone });
  } else {
    start = DateTime.fromISO(String(body.startAt || ''), { setZone: true });
  }

  if (body.endLocal) {
    end = DateTime.fromISO(String(body.endLocal), { zone: timezone });
  } else if (body.endAt) {
    end = DateTime.fromISO(String(body.endAt), { setZone: true });
  } else {
    const durationMinutes = Number(body.durationMinutes || 30);
    end = start.plus({ minutes: durationMinutes });
  }

  if (!start.isValid || !end.isValid) {
    const error = new Error('Start and end must be valid date/time values.');
    error.status = 400;
    throw error;
  }
  const startAt = start.toUTC();
  const endAt = end.toUTC();
  if (endAt <= startAt) {
    const error = new Error('End time must be after start time.');
    error.status = 400;
    throw error;
  }
  if (startAt < DateTime.utc().minus({ minutes: 1 })) {
    const error = new Error('New meetings must start in the future.');
    error.status = 400;
    throw error;
  }
  return { timezone, startAt: startAt.toJSDate(), endAt: endAt.toJSDate() };
}

function overlaps(startAt, endAt, otherStart, otherEnd) {
  return new Date(startAt) < new Date(otherEnd) && new Date(endAt) > new Date(otherStart);
}

async function findConflicts(userId, startAt, endAt, excludedMeetingId = '') {
  const meetings = await listMeetingRaw();
  return meetings.filter((meeting) => {
    if (idOf(meeting) === String(excludedMeetingId)) return false;
    if (meeting.status === 'cancelled') return false;
    const isParticipant = (meeting.participants || []).some(
      (participant) => getParticipantUserId(participant) === String(userId)
    );
    return isParticipant && overlaps(startAt, endAt, meeting.startAt, meeting.endAt);
  });
}

function conflictDTO(meeting, usersById) {
  return {
    id: idOf(meeting),
    title: meeting.title,
    startAt: dateIso(meeting.startAt),
    endAt: dateIso(meeting.endAt),
    status: meeting.status,
    participantNames: (meeting.participants || [])
      .map((participant) => userForParticipant(participant, usersById))
      .filter(Boolean)
      .map((user) => user.name)
  };
}

async function runAutoCancel() {
  const now = DateTime.utc();
  const meetings = await listMeetingRaw();
  let cancelled = 0;
  for (const meeting of meetings) {
    const grace = Number(meeting.autoCancelMinutes || AUTO_CANCEL_GRACE_MINUTES);
    const cutoff = DateTime.fromJSDate(new Date(meeting.startAt)).plus({ minutes: grace });
    const hasAttendee = (meeting.participants || []).some((participant) => participant.status === 'attending');
    if (meeting.status === 'scheduled' && cutoff <= now && !hasAttendee) {
      await updateMeetingRaw(idOf(meeting), {
        status: 'cancelled',
        cancellationReason: 'Automatically cancelled because no participant marked attending.'
      });
      await logAudit(null, 'auto_cancelled_meeting', 'meeting', idOf(meeting), {
        reason: 'no_attending_participants',
        graceMinutes: grace
      });
      cancelled += 1;
    }
  }
  return cancelled;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => !String(body[field] || '').trim());
  return missing;
}

// Database connection middleware for all API routes
app.use('/api', ensureDbConnected);

// Health and authentication
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'corporate-meeting-summarizer', database: dbMode, nowUtc: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const missing = requireFields(req.body, ['name', 'email', 'password']);
    if (missing.length) return res.status(400).json({ message: `Missing fields: ${missing.join(', ')}` });
    const email = normalizeEmail(req.body.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (String(req.body.password).length < 6) return res.status(400).json({ message: 'Password must contain at least 6 characters.' });
    const timezone = req.body.timezone || 'UTC';
    if (!validTimezone(timezone)) return res.status(400).json({ message: 'Invalid IANA timezone.' });
    if (await findUserByEmail(email)) return res.status(409).json({ message: 'An account with that email already exists.' });
    const user = await createUserRaw({
      name: String(req.body.name).trim(),
      email,
      passwordHash: await bcrypt.hash(String(req.body.password), 10),
      role: 'employee',
      timezone,
      department: String(req.body.department || 'General').trim(),
      performanceRating: 0,
      active: true
    });
    await logAudit(user, 'registered_account', 'user', idOf(user), { role: 'employee' });
    res.status(201).json({ token: signToken(user), user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (user.active === false) return res.status(403).json({ message: 'This account is inactive.' });
    const updated = await updateUserRaw(idOf(user), { lastLoginAt: new Date() });
    await logAudit(user, 'login_success', 'user', idOf(user));
    res.json({ token: signToken(updated || user), user: safeUser(updated || user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: safeUser(req.currentUser) });
});

// Users and employee performance

app.get('/api/users', auth, async (req, res, next) => {
  try {
    const users = await listUsersRaw();
    const visibleUsers = req.currentUser.role === 'admin'
      ? users
      : users.filter((user) => user.active !== false);
    res.json({ users: visibleUsers.map(safeUser) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const missing = requireFields(req.body, ['name', 'email', 'password']);
    if (missing.length) return res.status(400).json({ message: `Missing fields: ${missing.join(', ')}` });
    const email = normalizeEmail(req.body.email);
    if (await findUserByEmail(email)) return res.status(409).json({ message: 'An account with that email already exists.' });
    const timezone = req.body.timezone || 'UTC';
    if (!validTimezone(timezone)) return res.status(400).json({ message: 'Invalid IANA timezone.' });
    const user = await createUserRaw({
      name: String(req.body.name).trim(),
      email,
      passwordHash: await bcrypt.hash(String(req.body.password), 10),
      role: req.body.role === 'admin' ? 'admin' : 'employee',
      timezone,
      department: String(req.body.department || 'General').trim(),
      performanceRating: Math.max(0, Math.min(5, Number(req.body.performanceRating || 0))),
      active: true
    });
    await logAudit(req.currentUser, 'created_user', 'user', idOf(user), { role: user.role });
    res.status(201).json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/users/:id', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ message: 'User not found.' });
    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body.department !== undefined) patch.department = String(req.body.department).trim();
    if (req.body.timezone !== undefined) {
      if (!validTimezone(req.body.timezone)) return res.status(400).json({ message: 'Invalid IANA timezone.' });
      patch.timezone = req.body.timezone;
    }
    if (req.body.performanceRating !== undefined) {
      const rating = Number(req.body.performanceRating);
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) return res.status(400).json({ message: 'Rating must be between 0 and 5.' });
      patch.performanceRating = rating;
    }
    if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
    const user = await updateUserRaw(req.params.id, patch);
    await logAudit(req.currentUser, 'updated_user', 'user', req.params.id, patch);
    res.json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

// Employee meeting requests and admin approval workflow
app.post('/api/meeting-requests', auth, requireRole('employee'), async (req, res, next) => {
  try {
    const missing = requireFields(req.body, ['title']);
    if (missing.length) return res.status(400).json({ message: `Missing fields: ${missing.join(', ')}` });
    const schedule = parseSchedule(req.body);
    let participantIds = Array.isArray(req.body.participantIds) ? req.body.participantIds.map(String) : [];
    const allEmployees = Boolean(req.body.allEmployees);
    if (allEmployees) {
      const allUsers = await listUsersRaw();
      participantIds = allUsers.filter((user) => user.role === 'employee' && user.active !== false).map(idOf);
    }
    participantIds = [...new Set([idOf(req.currentUser), ...participantIds])];
    const selectedUsers = [];
    for (const participantId of participantIds) {
      const user = await findUserById(participantId);
      if (!user || user.active === false) {
        return res.status(400).json({ message: `User ${participantId} is not available.` });
      }
      selectedUsers.push(user);
    }
    const request = await createMeetingRequestRaw({
      requester: idOf(req.currentUser),
      title: String(req.body.title).trim(),
      agenda: String(req.body.agenda || req.body.description || '').trim(),
      requestedStartAt: schedule.startAt,
      requestedEndAt: schedule.endAt,
      timezone: schedule.timezone,
      participants: selectedUsers.map((user) => idOf(user)),
      roomPreference: String(req.body.roomPreference || '').trim(),
      assignedRoom: '',
      status: 'pending',
      rejectionReason: '',
      adminNote: '',
      approvedMeeting: null,
      approvedBy: null,
      approvedAt: null
    });
    await logAudit(req.currentUser, 'submitted_meeting_request', 'meeting_request', idOf(request), {
      title: req.body.title,
      participantCount: selectedUsers.length,
      timezone: schedule.timezone
    });
    res.status(201).json({ meetingRequest: meetingRequestDTO(request, await usersMap()) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/meeting-requests', auth, async (req, res, next) => {
  try {
    const requests = await listMeetingRequestRaw();
    const currentId = idOf(req.currentUser);
    const requestedStatus = String(req.query.status || '').trim().toLowerCase();
    const visible = requests.filter((request) => {
      const isAdmin = req.currentUser.role === 'admin';
      const isRequester = idOf(request.requester) === currentId;
      if (!isAdmin && !isRequester) return false;
      return !requestedStatus || request.status === requestedStatus;
    });
    const map = await usersMap();
    res.json({ meetingRequests: visible.map((request) => meetingRequestDTO(request, map)) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/meeting-requests/:id/approve', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const request = await findMeetingRequestRaw(req.params.id);
    if (!request) return res.status(404).json({ message: 'Meeting request not found.' });
    if (request.status !== 'pending') return res.status(400).json({ message: 'Only pending requests can be approved.' });
    const room = String(req.body.room || '').trim();
    if (!room) return res.status(400).json({ message: 'Assign a meeting room before approving.' });

    const participantIds = [...new Set((request.participants || []).map(idOf))];
    const selectedUsers = [];
    for (const participantId of participantIds) {
      const user = await findUserById(participantId);
      if (!user || user.active === false || user.role !== 'employee') {
        return res.status(400).json({ message: `A requested participant is no longer active: ${participantId}` });
      }
      selectedUsers.push(user);
    }
    const map = await usersMap();
    const conflicts = [];
    for (const user of selectedUsers) {
      const userConflicts = await findConflicts(idOf(user), request.requestedStartAt, request.requestedEndAt);
      if (userConflicts.length) {
        conflicts.push({ user: safeUser(user), meetings: userConflicts.map((meeting) => conflictDTO(meeting, map)) });
      }
    }
    if (conflicts.length && !Boolean(req.body.allowConflicts)) {
      return res.status(409).json({
        message: 'Approval blocked by meeting conflicts. Resolve the conflicts or use the conflict override.',
        conflicts
      });
    }
    const conflictIds = new Set(conflicts.map((item) => item.user.id));
    const requesterId = idOf(request.requester);
    const hostId = req.body.hostId || req.body.organizerId || requesterId;
    const meeting = await createMeetingRaw({
      title: request.title,
      description: request.agenda || '',
      summary: '',
      startAt: request.requestedStartAt,
      endAt: request.requestedEndAt,
      timezone: request.timezone,
      room,
      requestId: idOf(request),
      organizer: hostId,
      participants: selectedUsers.map((user) => {
        const uid = idOf(user);
        const isConflict = conflictIds.has(uid);
        const isHostOrRequester = uid === hostId || uid === requesterId;
        return {
          user: uid,
          status: isConflict ? 'busy' : isHostOrRequester ? 'attending' : 'pending',
          respondedAt: !isConflict && isHostOrRequester ? new Date() : null
        };
      }),
      status: 'scheduled',
      cancellationReason: '',
      autoCancelMinutes: AUTO_CANCEL_GRACE_MINUTES
    });
    const updatedRequest = await updateMeetingRequestRaw(req.params.id, {
      status: 'approved',
      assignedRoom: room,
      approvedMeeting: idOf(meeting),
      approvedBy: idOf(req.currentUser),
      approvedAt: new Date(),
      adminNote: String(req.body.adminNote || '').trim()
    });
    await logAudit(req.currentUser, 'approved_meeting_request', 'meeting_request', req.params.id, {
      meetingId: idOf(meeting),
      room,
      conflictOverride: Boolean(req.body.allowConflicts)
    });
    res.json({ meetingRequest: meetingRequestDTO(updatedRequest, map), meeting: meetingDTO(meeting, map), conflicts });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/meeting-requests/:id/reject', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const request = await findMeetingRequestRaw(req.params.id);
    if (!request) return res.status(404).json({ message: 'Meeting request not found.' });
    if (request.status !== 'pending') return res.status(400).json({ message: 'Only pending requests can be rejected.' });
    const reason = String(req.body.reason || 'Rejected by administrator').trim();
    const updatedRequest = await updateMeetingRequestRaw(req.params.id, {
      status: 'rejected',
      rejectionReason: reason,
      adminNote: String(req.body.adminNote || '').trim()
    });
    await logAudit(req.currentUser, 'rejected_meeting_request', 'meeting_request', req.params.id, { reason });
    res.json({ meetingRequest: meetingRequestDTO(updatedRequest, await usersMap()) });
  } catch (error) {
    next(error);
  }
});

// Meetings
app.get('/api/meetings', auth, async (req, res, next) => {
  try {
    const rawMeetings = await listMeetingRaw();
    const map = await usersMap();
    const currentId = idOf(req.currentUser);
    const q = String(req.query.q || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim().toLowerCase();
    const filtered = rawMeetings.filter((meeting) => {
      const isAdmin = req.currentUser.role === 'admin';
      const isParticipant = (meeting.participants || []).some((participant) => getParticipantUserId(participant) === currentId);
      const isOrganizer = idOf(meeting.organizer) === currentId;
      if (!isAdmin && !isParticipant && !isOrganizer) return false;
      if (status && meeting.status !== status) return false;
      if (!q) return true;
      const dto = meetingDTO(meeting, map);
      return `${dto.title} ${dto.description} ${dto.timezone} ${dto.organizer?.name || ''} ${dto.participants.map((p) => p.user?.name || '').join(' ')}`.toLowerCase().includes(q);
    });
    res.json({ meetings: filtered.map((meeting) => meetingDTO(meeting, map)), nowUtc: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/meetings/:id', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingRaw(req.params.id);
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    const isAdmin = req.currentUser.role === 'admin';
    const isParticipant = (meeting.participants || []).some((participant) => getParticipantUserId(participant) === idOf(req.currentUser));
    if (!isAdmin && !isParticipant) return res.status(403).json({ message: 'You cannot view this meeting.' });
    res.json({ meeting: meetingDTO(meeting, await usersMap()) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/meetings', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const missing = requireFields(req.body, ['title']);
    if (missing.length) return res.status(400).json({ message: `Missing fields: ${missing.join(', ')}` });
    const schedule = parseSchedule(req.body);
    let participantIds = Array.isArray(req.body.participantIds) ? req.body.participantIds.map(String) : [];
    const allEmployees = Boolean(req.body.allEmployees);
    const allUsers = await listUsersRaw();
    if (allEmployees) {
      participantIds = allUsers.filter((user) => user.role === 'employee' && user.active !== false).map(idOf);
    }
    participantIds = [...new Set(participantIds)];
    if (!participantIds.length) return res.status(400).json({ message: 'Select at least one employee or choose Everyone.' });
    const selectedUsers = [];
    for (const participantId of participantIds) {
      const user = await findUserById(participantId);
      if (!user || user.active === false || user.role !== 'employee') {
        return res.status(400).json({ message: `Employee ${participantId} is not available.` });
      }
      selectedUsers.push(user);
    }

    const map = await usersMap();
    const conflicts = [];
    for (const user of selectedUsers) {
      const userConflicts = await findConflicts(idOf(user), schedule.startAt, schedule.endAt);
      if (userConflicts.length) {
        conflicts.push({
          user: safeUser(user),
          meetings: userConflicts.map((meeting) => conflictDTO(meeting, map))
        });
      }
    }
    if (conflicts.length && !Boolean(req.body.allowConflicts)) {
      return res.status(409).json({
        message: 'Conflict validation failed. One or more selected employees already have a meeting in this time range.',
        conflicts
      });
    }

    const conflictIds = new Set(conflicts.map((item) => item.user.id));
    let hostUser = null;
    if (req.body.hostId || req.body.organizerId || req.body.host) {
      hostUser = await findUserById(req.body.hostId || req.body.organizerId || req.body.host);
    }
    const organizerId = hostUser ? idOf(hostUser) : idOf(req.currentUser);
    if (hostUser && !selectedUsers.some((u) => idOf(u) === organizerId)) {
      selectedUsers.unshift(hostUser);
    }
    const meeting = await createMeetingRaw({
      title: String(req.body.title).trim(),
      description: String(req.body.description || '').trim(),
      summary: String(req.body.summary || '').trim(),
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      timezone: schedule.timezone,
      organizer: organizerId,
      participants: selectedUsers.map((user) => {
        const uid = idOf(user);
        const isOrganizer = uid === organizerId;
        return {
          user: uid,
          status: conflictIds.has(uid) ? 'busy' : isOrganizer ? 'attending' : 'pending',
          respondedAt: isOrganizer ? new Date() : null
        };
      }),
      status: 'scheduled',
      cancellationReason: '',
      autoCancelMinutes: Math.max(0, Number(req.body.autoCancelMinutes || AUTO_CANCEL_GRACE_MINUTES))
    });
    await logAudit(req.currentUser, 'created_meeting', 'meeting', idOf(meeting), {
      title: req.body.title,
      participantCount: selectedUsers.length,
      timezone: schedule.timezone,
      startAtUtc: schedule.startAt.toISOString(),
      conflictOverride: Boolean(req.body.allowConflicts)
    });
    res.status(201).json({ meeting: meetingDTO(meeting, map), conflicts });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/meetings/:id/participants/:userId/status', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingRaw(req.params.id);
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    const targetUserId = String(req.params.userId);
    if (req.currentUser.role !== 'admin' && targetUserId !== idOf(req.currentUser)) {
      return res.status(403).json({ message: 'You can only update your own attendance.' });
    }
    const requestedStatus = String(req.body.status || '').toLowerCase();
    const allowed = req.currentUser.role === 'admin'
      ? ['pending', 'attending', 'absent', 'busy']
      : ['attending', 'absent'];
    if (!allowed.includes(requestedStatus)) return res.status(400).json({ message: `Status must be one of: ${allowed.join(', ')}.` });
    const participant = (meeting.participants || []).find((item) => getParticipantUserId(item) === targetUserId);
    if (!participant) return res.status(404).json({ message: 'This employee is not part of the meeting.' });
    if (meeting.status === 'cancelled') return res.status(400).json({ message: 'Cancelled meetings cannot receive attendance responses.' });

    if (requestedStatus === 'attending') {
      const conflicts = await findConflicts(targetUserId, meeting.startAt, meeting.endAt, idOf(meeting));
      const activeAttendingConflicts = conflicts.filter((c) => {
        const p = (c.participants || []).find((item) => getParticipantUserId(item) === targetUserId);
        return p && p.status === 'attending';
      });
      if (activeAttendingConflicts.length) {
        const map = await usersMap();
        return res.status(409).json({
          message: 'This employee is already attending another meeting during this time range. Please update your response on the other meeting first.',
          conflicts: activeAttendingConflicts.map((item) => conflictDTO(item, map))
        });
      }
    }

    const absenceReason = String(req.body.reason || req.body.absenceReason || '').trim();
    const updatedMeeting = await updateParticipantRaw(req.params.id, targetUserId, {
      status: requestedStatus,
      absenceReason: requestedStatus === 'attending' ? '' : (absenceReason || participant.absenceReason || ''),
      respondedAt: new Date()
    });
    await logAudit(req.currentUser, `marked_${requestedStatus}`, 'meeting_participant', `${req.params.id}:${targetUserId}`, {
      meetingId: req.params.id,
      employeeId: targetUserId,
      reason: absenceReason
    });
    res.json({ meeting: meetingDTO(updatedMeeting, await usersMap()) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/meetings/:id/status', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const meeting = await findMeetingRaw(req.params.id);
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    const status = String(req.body.status || '').toLowerCase();
    if (!['scheduled', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ message: 'Invalid meeting status.' });
    const meetingPatch = {
      status,
      cancellationReason: status === 'cancelled' ? String(req.body.reason || 'Cancelled by administrator') : ''
    };
    if (req.body.summary !== undefined) meetingPatch.summary = String(req.body.summary || '').trim();
    const updated = await updateMeetingRaw(req.params.id, meetingPatch);
    await logAudit(req.currentUser, `meeting_${status}`, 'meeting', req.params.id, { reason: req.body.reason || '', summaryUpdated: req.body.summary !== undefined });
    res.json({ meeting: meetingDTO(updated, await usersMap()) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/run', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const cancelled = await runAutoCancel();
    await logAudit(req.currentUser, 'ran_auto_cancel_job', 'automation', 'auto-cancel', { cancelled });
    res.json({ cancelled, message: `${cancelled} meeting(s) auto-cancelled.` });
  } catch (error) {
    next(error);
  }
});

// Analytics, Excel export and JSON backup
app.get('/api/analytics', auth, async (req, res, next) => {
  try {
    const meetings = await listMeetingRaw();
    const users = await listUsersRaw();
    const employees = users.filter((user) => user.role === 'employee');
    const currentId = idOf(req.currentUser);
    const visibleMeetings = req.currentUser.role === 'admin'
      ? meetings
      : meetings.filter((meeting) => (meeting.participants || []).some((participant) => getParticipantUserId(participant) === currentId));
    const statusCounts = { scheduled: 0, completed: 0, cancelled: 0 };
    visibleMeetings.forEach((meeting) => { statusCounts[meeting.status] = (statusCounts[meeting.status] || 0) + 1; });
    const attendance = employees.map((employee) => {
      const assigned = meetings.filter((meeting) => (meeting.participants || []).some((participant) => getParticipantUserId(participant) === idOf(employee)));
      const attending = assigned.filter((meeting) => (meeting.participants || []).some((participant) => getParticipantUserId(participant) === idOf(employee) && participant.status === 'attending')).length;
      const absent = assigned.filter((meeting) => (meeting.participants || []).some((participant) => getParticipantUserId(participant) === idOf(employee) && participant.status === 'absent')).length;
      return {
        userId: idOf(employee),
        name: employee.name,
        rating: Number(employee.performanceRating || 0),
        assigned: assigned.length,
        attending,
        absent,
        attendanceRate: assigned.length ? Math.round((attending / assigned.length) * 100) : 0
      };
    });
    res.json({ statusCounts, attendance, totals: { meetings: visibleMeetings.length, employees: employees.length } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/audit-logs', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const map = await usersMap();
    const logs = await listAuditRaw();
    res.json({ logs: logs.map((log) => auditDTO(log, map)) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/meetings.xlsx', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const meetings = await listMeetingRaw();
    const map = await usersMap();
    const rows = [];
    meetings.forEach((meeting) => {
      const dto = meetingDTO(meeting, map);
      if (!dto.participants.length) {
        rows.push({
          Meeting: dto.title,
          Description: dto.description,
          Summary: dto.summary,
          Room: dto.room,
          'Start UTC': dto.startAt,
          'End UTC': dto.endAt,
          'Schedule timezone': dto.timezone,
          Status: dto.status,
          Host: dto.organizer?.name || '',
          Employee: '',
          Email: '',
          'Attendance status': ''
        });
      } else {
        dto.participants.forEach((participant) => rows.push({
          Meeting: dto.title,
          Description: dto.description,
          Summary: dto.summary,
          Room: dto.room,
          'Start UTC': dto.startAt,
          'End UTC': dto.endAt,
          'Schedule timezone': dto.timezone,
          Status: dto.status,
          Host: dto.organizer?.name || '',
          Employee: participant.user?.name || '',
          Email: participant.user?.email || '',
          'Attendance status': participant.status
        }));
      }
    });
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Meetings');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="corporate-meetings.xlsx"');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

// Static application
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? 'Unexpected server error.' : error.message });
});

if (!process.env.VERCEL) {
  (async () => {
    await connectDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Corporate Meeting Summarizer running at http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
    cron.schedule('* * * * *', () => {
      runAutoCancel().catch((error) => console.error('Auto-cancel job error:', error.message));
    }, { timezone: 'UTC' });
  })();
} else {
  connectDatabase().catch((error) => console.error('DB connection error on Vercel:', error));
}

module.exports = app;
