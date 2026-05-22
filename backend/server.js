const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 4000;
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/busbooking';
const jwtSecret = process.env.JWT_SECRET || 'busbooking-secret';
const defaultAdminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@gmail.com';
const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@123';
const defaultAdminName = process.env.DEFAULT_ADMIN_NAME || 'System Admin';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

mongoose
  .connect(mongoUri)
  .then(async () => {
    console.log(`MongoDB connected: ${mongoUri}`);

    try {
      await ensureDefaultAdmin();
    } catch (error) {
      console.error('Default admin seed failed:', error.message);
    }
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin', 'conductor'], required: true },
  },
  { timestamps: true }
);

const busSchema = new mongoose.Schema(
  {
    busNumber: { type: String, required: true, unique: true, trim: true },
    seats: { type: Number, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    daily: { type: Boolean, default: true },
    isVisible: { type: Boolean, default: true },
    busType: { type: String, enum: ['Local', 'TNSTC', 'Others'], default: 'Local' },
    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    stops: [
      {
        name: { type: String, trim: true },
        lat: { type: Number, default: 0 },
        lng: { type: Number, default: 0 },
      },
    ],
    conductor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    currentLocation: {
      lat: { type: Number, default: 0 },
      lng: { type: Number, default: 0 },
      updatedAt: { type: Date },
    },
    timings: [
      {
        label: { type: String, required: true },
        startTime: { type: String, required: true },
        endTime: { type: String, required: true },
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    qrToken: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

const bookingSchema = new mongoose.Schema(
  {
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    travelDate: { type: String, required: true },
    timingLabel: { type: String, required: true },
    startStop: { type: String, required: true },
    endStop: { type: String, required: true },
    seats: { type: Number, required: true },
    otp: { type: String, required: true },
    qrToken: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'verified'], default: 'pending' },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    verifiedAt: { type: Date },
    offlineMode: { type: Boolean, default: false },
    offlineRef: { type: String, unique: true, sparse: true },
    offlinePayload: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    trackingUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);
const Bus = mongoose.model('Bus', busSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const AppConfig = mongoose.model('AppConfig', appConfigSchema);

async function ensureDefaultAdmin() {
  const normalizedEmail = defaultAdminEmail.trim().toLowerCase();
  const existingAdmin = await User.findOne({ email: normalizedEmail });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(defaultAdminPassword, 10);
    await User.create({
      name: defaultAdminName,
      email: normalizedEmail,
      passwordHash,
      role: 'admin',
    });
    console.log(`Default admin created: ${normalizedEmail}`);
    return;
  }

  if (existingAdmin.role !== 'admin') {
    existingAdmin.role = 'admin';
    await existingAdmin.save();
    console.log(`Existing user promoted to admin: ${normalizedEmail}`);
  }
}

function createToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, jwtSecret, { expiresIn: '30d' });
}

function buildPublicUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');

  if (!token) {
    return res.status(401).json({ message: 'Authorization token is required' });
  }

  try {
    req.auth = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }

  return next();
}

function conductorOrAdmin(req, res, next) {
  if (!['admin', 'conductor'].includes(req.auth?.role)) {
    return res.status(403).json({ message: 'Conductor or admin access required' });
  }

  return next();
}

function createOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createQrToken(prefix, id) {
  return `${prefix}:${id}`;
}

const IST_OFFSET_MINUTES = 330;

function parseDateTimeInIST(dateValue, timeValue) {
  const base = String(timeValue || '').trim();
  const match = base.match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);

  if (!match) {
    const fallback = new Date(`${dateValue} ${base}`);
    if (!Number.isNaN(fallback.getTime())) {
      return fallback;
    }

    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const period = match[3] ? match[3].toUpperCase() : null;

  if (period === 'AM' && hours === 12) {
    hours = 0;
  }

  if (period === 'PM' && hours !== 12) {
    hours += 12;
  }

  const [year, month, day] = String(dateValue).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }

  const utcMillis = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - (IST_OFFSET_MINUTES * 60 * 1000);
  return new Date(utcMillis);
}

function normalizeRemoteUrl(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function normalizeRouteLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function getBusStopLabel(stop) {
  if (typeof stop === 'string') {
    return stop.trim();
  }

  if (stop && typeof stop === 'object') {
    return String(stop.name || '').trim();
  }

  return '';
}

function buildBusRouteSequence(bus) {
  const sequence = [];

  const append = (value) => {
    const label = String(value || '').trim();
    if (!label) {
      return;
    }

    const normalized = normalizeRouteLabel(label);
    const previous = sequence[sequence.length - 1];
    if (previous && previous.normalized === normalized) {
      return;
    }

    sequence.push({ name: label, normalized });
  };

  append(bus.from);
  (Array.isArray(bus.stops) ? bus.stops : []).forEach((stop) => append(getBusStopLabel(stop)));
  append(bus.to);

  return sequence;
}

function getCrowdPresentation(availabilityPercent) {
  if (availabilityPercent >= 100) {
    return { label: 'no crowded', color: '#22C55E' };
  }

  if (availabilityPercent >= 50) {
    return { label: 'less crowded', color: '#EAB308' };
  }

  return { label: 'most crowded', color: '#EF4444' };
}

async function attachCrowdSummary(buses) {
  const busList = Array.isArray(buses) ? buses : [];
  const busIds = busList.map((bus) => bus._id).filter(Boolean);

  if (!busIds.length) {
    return busList.map((bus) => ({
      ...bus.toObject(),
      bookedSeats: 0,
      availableSeats: Number(bus.seats || 0),
      availabilityPercent: 100,
      crowdStatus: 'no crowded',
      crowdColor: '#22C55E',
    }));
  }

  const bookedSeatTotals = await Booking.aggregate([
    {
      $match: {
        bus: { $in: busIds },
        status: { $in: ['pending', 'verified'] },
      },
    },
    {
      $group: {
        _id: '$bus',
        bookedSeats: { $sum: '$seats' },
      },
    },
  ]);

  const bookedSeatMap = new Map(bookedSeatTotals.map((row) => [String(row._id), Number(row.bookedSeats || 0)]));

  return busList.map((bus) => {
    const busObject = typeof bus.toObject === 'function' ? bus.toObject() : { ...bus };
    const totalSeats = Number(busObject.seats || 0);
    const bookedSeats = bookedSeatMap.get(String(busObject._id)) || 0;
    const availableSeats = Math.max(totalSeats - bookedSeats, 0);
    const availabilityPercent = totalSeats > 0 ? Math.max(0, Math.min(100, Math.round((availableSeats / totalSeats) * 100))) : 0;
    const crowd = getCrowdPresentation(availabilityPercent);

    return {
      ...busObject,
      bookedSeats,
      availableSeats,
      availabilityPercent,
      crowdStatus: crowd.label,
      crowdColor: crowd.color,
    };
  });
}

function findRouteStopIndex(routeSequence, selectedStop) {
  const normalizedSelectedStop = normalizeRouteLabel(selectedStop);
  return routeSequence.findIndex((routeStop) => routeStop.normalized === normalizedSelectedStop);
}

function buildRouteGraph(buses) {
  const graph = new Map();

  const addEdge = (from, edge) => {
    const current = graph.get(from) || [];
    current.push(edge);
    graph.set(from, current);
  };

  buses.forEach((bus) => {
    const routeSequence = buildBusRouteSequence(bus);

    for (let fromIndex = 0; fromIndex < routeSequence.length - 1; fromIndex += 1) {
      for (let toIndex = fromIndex + 1; toIndex < routeSequence.length; toIndex += 1) {
        const routeStops = routeSequence.slice(fromIndex, toIndex + 1).map((stop) => stop.name);

        addEdge(routeSequence[fromIndex].normalized, {
          to: routeSequence[toIndex].normalized,
          fromStop: routeSequence[fromIndex].name,
          toStop: routeSequence[toIndex].name,
          busId: bus._id.toString(),
          busNumber: bus.busNumber,
          routeStops,
        });
      }
    }
  });

  return graph;
}

function formatRouteSummary(routeSegments) {
  if (!routeSegments.length) {
    return '';
  }

  return routeSegments
    .map((segment, index) => {
      const routeText = segment.routeStops.join(' -> ');
      if (index === 0) {
        return `Take Bus ${segment.busNumber} from ${segment.fromStop} to ${segment.toStop}${routeText ? ` via ${routeText}` : ''}.`;
      }

      return `Then switch to Bus ${segment.busNumber} at ${segment.fromStop} and continue to ${segment.toStop}${routeText ? ` via ${routeText}` : ''}.`;
    })
    .join(' ');
}

function findRoutePlan(buses, fromCity, toCity) {
  const startLabel = String(fromCity || '').trim();
  const endLabel = String(toCity || '').trim();

  if (!startLabel || !endLabel) {
    return { error: 'From city and To city are required' };
  }

  const startKey = normalizeRouteLabel(startLabel);
  const endKey = normalizeRouteLabel(endLabel);

  if (startKey === endKey) {
    return { error: 'From city and To city must be different' };
  }

  const graph = buildRouteGraph(buses);
  const queue = [startKey];
  const visited = new Set([startKey]);
  const previous = new Map();

  while (queue.length) {
    const current = queue.shift();

    if (current === endKey) {
      break;
    }

    const edges = graph.get(current) || [];
    edges.forEach((edge) => {
      if (visited.has(edge.to)) {
        return;
      }

      visited.add(edge.to);
      previous.set(edge.to, { from: current, edge });
      queue.push(edge.to);
    });
  }

  if (!visited.has(endKey)) {
    return {
      found: false,
      from: startLabel,
      to: endLabel,
      message: `No connected bus route found from ${startLabel} to ${endLabel}.`,
    };
  }

  const routeSegments = [];
  let current = endKey;

  while (current !== startKey) {
    const step = previous.get(current);
    if (!step) {
      break;
    }

    routeSegments.push({
      busId: step.edge.busId,
      busNumber: step.edge.busNumber,
      fromStop: step.edge.fromStop,
      toStop: step.edge.toStop,
      routeStops: step.edge.routeStops,
    });
    current = step.from;
  }

  routeSegments.reverse();

  return {
    found: true,
    from: startLabel,
    to: endLabel,
    transfers: Math.max(0, routeSegments.length - 1),
    segments: routeSegments,
    summary: formatRouteSummary(routeSegments),
  };
}

function buildBusQrPayload(busDoc) {
  const bus = typeof busDoc.toObject === 'function' ? busDoc.toObject() : busDoc;

  return JSON.stringify({
    type: 'bus',
    id: bus._id.toString(),
    bus: {
      _id: bus._id.toString(),
      busNumber: bus.busNumber,
      seats: bus.seats,
      startTime: bus.startTime,
      endTime: bus.endTime,
      daily: bus.daily,
      busType: bus.busType,
      from: bus.from,
      to: bus.to,
      stops: Array.isArray(bus.stops) ? bus.stops : [],
      timings: Array.isArray(bus.timings) ? bus.timings : [],
    },
  });
}

async function buildBusQrDataUrl(busDoc) {
  return QRCode.toDataURL(buildBusQrPayload(busDoc));
}

function parseTime(dateValue, timeValue) {
  const parsed = parseDateTimeInIST(dateValue, timeValue);

  if (parsed) {
    return parsed;
  }

  throw new Error(`Invalid time format: ${timeValue}`);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Name, email, password, and role are required' });
    }

    if (!['user', 'admin', 'conductor'].includes(role)) {
      return res.status(400).json({ message: 'Role must be user, admin or conductor' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name: name.trim(), email: email.trim(), passwordHash, role });
    const token = createToken(user);

    return res.status(201).json({ user: buildPublicUser(user), token });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = createToken(user);
    return res.json({ user: buildPublicUser(user), token });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/api/settings/tracking-url', authRequired, async (req, res) => {
  try {
    const config = await AppConfig.findOne({ key: 'global' });
    return res.json({ trackingUrl: config?.trackingUrl || '' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.put('/api/settings/tracking-url', authRequired, adminOnly, async (req, res) => {
  try {
    const trackingUrl = normalizeRemoteUrl(req.body?.trackingUrl);

    if (!trackingUrl) {
      return res.status(400).json({ message: 'trackingUrl is required' });
    }

    const config = await AppConfig.findOneAndUpdate(
      { key: 'global' },
      { key: 'global', trackingUrl },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ trackingUrl: config.trackingUrl });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/api/buses', authRequired, async (req, res) => {
  try {
    const { number, type, conductorId } = req.query;
    const userFacingOnlyVisible = req.auth?.role === 'user';

    if (number) {
      const busFilter = {
        busNumber: number.trim(),
        ...(userFacingOnlyVisible ? { $or: [{ isVisible: true }, { isVisible: { $exists: false } }] } : {}),
      };
      const bus = await Bus.findOne(busFilter).populate('createdBy', 'name email role').populate('conductor', 'name email role');
      if (!bus) {
        return res.json({ bus: null });
      }

      const qrDataUrl = await buildBusQrDataUrl(bus);
      const [busWithCrowd] = await attachCrowdSummary([bus]);
      return res.json({
        bus: {
          ...busWithCrowd,
          qrDataUrl,
        },
      });
    }

    const filter = {};
    if (type) {
      filter.busType = type;
    }
    if (conductorId) {
      filter.conductor = conductorId;
    }
    if (userFacingOnlyVisible) {
      filter.$or = [{ isVisible: true }, { isVisible: { $exists: false } }];
    }
    const buses = await Bus.find(filter).sort({ createdAt: -1 }).populate('createdBy', 'name email role').populate('conductor', 'name email role');
    const busesWithCrowd = await attachCrowdSummary(buses);
    const busesWithQr = await Promise.all(
      busesWithCrowd.map(async (bus) => ({
        ...bus,
        qrDataUrl: await buildBusQrDataUrl(bus),
      }))
    );

    return res.json({ buses: busesWithQr });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/api/buses/:id', authRequired, async (req, res) => {
  try {
    const bus = await Bus.findById(req.params.id).populate('createdBy', 'name email role');
    if (!bus) {
      return res.status(404).json({ message: 'Bus not found' });
    }

    if (req.auth?.role === 'user' && bus.isVisible === false) {
      return res.status(404).json({ message: 'Bus not found' });
    }

    const qrDataUrl = await buildBusQrDataUrl(bus);
    const [busWithCrowd] = await attachCrowdSummary([bus]);
    return res.json({
      bus: {
        ...busWithCrowd,
        qrDataUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/api/routes/inventory', authRequired, async (req, res) => {
  try {
    const buses = await Bus.find({})
      .select('busNumber from to stops isVisible')
      .sort({ from: 1, to: 1, busNumber: 1 });

    return res.json({
      buses: buses.map((bus) => ({
        _id: bus._id,
        busNumber: bus.busNumber,
        from: bus.from,
        to: bus.to,
        stops: Array.isArray(bus.stops) ? bus.stops : [],
        isVisible: bus.isVisible,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/routes/plan', authRequired, async (req, res) => {
  try {
    const { from, to, fromCity, toCity } = req.body || {};
    const visibleFilter = req.auth?.role === 'user'
      ? { $or: [{ isVisible: true }, { isVisible: { $exists: false } }] }
      : {};
    const plan = findRoutePlan(await Bus.find(visibleFilter), from || fromCity, to || toCity);

    if (plan.error) {
      return res.status(400).json({ message: plan.error });
    }

    return res.json({ route: plan });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/buses', authRequired, adminOnly, async (req, res) => {
  try {
  const { busNumber, seats, startTime, endTime, startPeriod, endPeriod, daily, from, to, stops, busType, conductorId } = req.body || {};
    
    // Process stops: handle both old string format and new object format with coordinates
    const cleanStops = Array.isArray(stops) ? stops.map((stop) => {
      if (typeof stop === 'string') {
        // Backward compatibility: convert string to object format with default coordinates
        return {
          name: String(stop).trim(),
          lat: 0,
          lng: 0,
        };
      } else if (typeof stop === 'object' && stop !== null) {
        // New format with coordinates
        return {
          name: String(stop.name || '').trim(),
          lat: typeof stop.lat === 'number' ? stop.lat : 0,
          lng: typeof stop.lng === 'number' ? stop.lng : 0,
        };
      }
      return null;
    }).filter((stop) => stop && stop.name) : [];

    if (!busNumber || !seats || !startTime || !endTime || !from || !to) {
      return res.status(400).json({ message: 'Bus number, seats, timings, from, and to are required' });
    }

    if (cleanStops.length < 2) {
      return res.status(400).json({ message: 'At least 2 stops are required' });
    }

    const existingBus = await Bus.findOne({ busNumber: busNumber.trim() });
    if (existingBus) {
      return res.status(409).json({ message: 'Bus number already exists' });
    }

    // If frontend provides AM/PM dropdowns (`startPeriod`/`endPeriod`), include them in stored labels.
    const sp = startPeriod ? String(startPeriod).trim().toUpperCase() : '';
    const ep = endPeriod ? String(endPeriod).trim().toUpperCase() : '';
    const startLabel = sp ? `${startTime} ${sp}` : String(startTime);
    const endLabel = ep ? `${endTime} ${ep}` : String(endTime);

    const bus = await Bus.create({
      busNumber: busNumber.trim(),
      seats: Number(seats),
      startTime: startLabel,
      endTime: endLabel,
      daily: Boolean(daily),
      busType: busType || 'Local',
      from: from.trim(),
      to: to.trim(),
      stops: cleanStops,
      conductor: conductorId || undefined,
      timings: [
        {
          label: `${startLabel} - ${endLabel}`,
          startTime: startLabel,
          endTime: endLabel,
        },
      ],
      createdBy: req.auth.id,
      qrToken: createQrToken('bus', new mongoose.Types.ObjectId().toString()),
    });

    bus.qrToken = createQrToken('bus', bus._id.toString());
    await bus.save();

    const qrDataUrl = await buildBusQrDataUrl(bus);

    return res.status(201).json({
      bus: {
        ...bus.toObject(),
        qrDataUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// List users (admin only) - optional filter by role
app.get('/api/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    const users = await User.find(filter).select('name email role').sort({ name: 1 });
    return res.json({ users });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Conductor (or admin) can post current location for a bus
app.post('/api/buses/:id/location', authRequired, async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ message: 'lat and lng (numbers) are required' });
    }

    const bus = await Bus.findById(req.params.id);
    if (!bus) return res.status(404).json({ message: 'Bus not found' });

    // Only the assigned conductor or an admin may update location
    if (req.auth.role !== 'admin' && String(bus.conductor || '') !== String(req.auth.id)) {
      return res.status(403).json({ message: 'Only assigned conductor or admin may update location' });
    }

    bus.currentLocation = { lat, lng, updatedAt: new Date() };
    await bus.save();

    return res.json({ message: 'Location updated', bus: bus.toObject() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Admin can assign or change conductor for a bus
app.post('/api/buses/:id/assign-conductor', authRequired, adminOnly, async (req, res) => {
  try {
    const { conductorId } = req.body || {};
    if (!conductorId) return res.status(400).json({ message: 'conductorId is required' });

    const user = await User.findById(conductorId);
    if (!user) return res.status(404).json({ message: 'Conductor not found' });
    if (user.role !== 'conductor') return res.status(400).json({ message: 'User is not a conductor' });

    const bus = await Bus.findById(req.params.id);
    if (!bus) return res.status(404).json({ message: 'Bus not found' });

    bus.conductor = user._id;
    await bus.save();

    const populated = await Bus.findById(bus._id).populate('conductor', 'name email role');
    return res.json({ message: 'Conductor assigned', bus: populated.toObject() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Update a specific stop's location for a bus (conductor or admin)
app.post('/api/buses/:id/stops/:index/location', authRequired, async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ message: 'Invalid stop index' });
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ message: 'lat and lng (numbers) are required' });

    const bus = await Bus.findById(req.params.id);
    if (!bus) return res.status(404).json({ message: 'Bus not found' });

    // Only assigned conductor or admin may update stop locations
    if (req.auth.role !== 'admin' && String(bus.conductor || '') !== String(req.auth.id)) {
      return res.status(403).json({ message: 'Only assigned conductor or admin may update stop locations' });
    }

    if (!Array.isArray(bus.stops) || idx >= bus.stops.length) return res.status(400).json({ message: 'Stop index out of range' });

    bus.stops[idx].lat = lat;
    bus.stops[idx].lng = lng;
    await bus.save();

    return res.json({ message: 'Stop location updated', bus: bus.toObject() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Conductor or admin can toggle whether a bus is visible to users
app.post('/api/buses/:id/visibility', authRequired, conductorOrAdmin, async (req, res) => {
  try {
    const { isVisible } = req.body || {};
    if (typeof isVisible !== 'boolean') {
      return res.status(400).json({ message: 'isVisible must be a boolean' });
    }

    const bus = await Bus.findById(req.params.id);
    if (!bus) {
      return res.status(404).json({ message: 'Bus not found' });
    }

    if (req.auth.role === 'conductor' && String(bus.conductor || '') !== String(req.auth.id)) {
      return res.status(403).json({ message: 'Only assigned conductor may toggle bus visibility' });
    }

    bus.isVisible = isVisible;
    await bus.save();

    return res.json({ message: 'Bus visibility updated', bus: bus.toObject() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/bookings', authRequired, async (req, res) => {
  try {
    const { busId, travelDate, timingLabel, startStop, endStop, seats } = req.body || {};

    if (!busId || !travelDate || !timingLabel || !startStop || !endStop || !seats) {
      return res.status(400).json({ message: 'Bus, travel date, timing, stops, and seats are required' });
    }

    const bus = await Bus.findById(busId);
    if (!bus) {
      return res.status(404).json({ message: 'Bus not found' });
    }

    const selectedTiming = bus.timings.find((timing) => timing.label === timingLabel);
    if (!selectedTiming) {
      return res.status(400).json({ message: 'Selected timing is not available for this bus' });
    }

    const routeSequence = buildBusRouteSequence(bus);
    const startIndex = findRouteStopIndex(routeSequence, startStop);
    const endIndex = findRouteStopIndex(routeSequence, endStop);

    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      return res.status(400).json({ message: 'Choose a valid start and end stop in route order' });
    }

    const seatsRequested = Number(seats);
    if (!Number.isInteger(seatsRequested) || seatsRequested < 1 || seatsRequested > bus.seats) {
      return res.status(400).json({ message: `Seats must be between 1 and ${bus.seats}` });
    }

    // Robust parsing of timingLabel to extract start and end times (handles "-", "to", with or without spaces)
    const timingMatch = timingLabel.match(/^(.+?)\s*(?:-|to)\s*(.+)$/i);
    if (!timingMatch) {
      return res.status(400).json({ message: 'Invalid timing format. Expected "start - end" or "start to end"' });
    }
    const startTime = timingMatch[1].trim();
    const endTime = timingMatch[2].trim();
    const validFrom = parseTime(travelDate, startTime);
    const validTo = parseTime(travelDate, endTime);
    const otp = createOtp();
    const qrToken = createQrToken('ticket', new mongoose.Types.ObjectId().toString());

    const booking = await Booking.create({
      bus: bus._id,
      user: req.auth.id,
      travelDate,
      timingLabel,
      startStop,
      endStop,
      seats: seatsRequested,
      otp,
      qrToken,
      status: 'pending',
      validFrom,
      validTo,
    });

    const populatedBooking = await Booking.findById(booking._id)
      .populate('bus')
      .populate('user', 'name email role');

    const qrDataUrl = await QRCode.toDataURL(qrToken);

    const bookingObj = populatedBooking.toObject();
    const now = new Date();
    // Add 5 minute buffer to account for clock skew between client and server
    const bufferMs = 5 * 60 * 1000;
    // Only expose OTP during the valid window (inclusive) - compare UTC timestamps with buffer
    if (!bookingObj.validFrom || !bookingObj.validTo || now < new Date(bookingObj.validFrom.getTime() - bufferMs) || now > new Date(bookingObj.validTo.getTime() + bufferMs)) {
      delete bookingObj.otp;
    }

    return res.status(201).json({
      booking: {
        ...bookingObj,
        qrDataUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/api/bookings/me', authRequired, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.auth.id })
      .populate('bus')
      .sort({ createdAt: -1 });

    const now = new Date();
    // Add 5 minute buffer to account for clock skew between client and server
    const bufferMs = 5 * 60 * 1000;
    const bookingsWithQr = await Promise.all(
      bookings.map(async (booking) => {
        const obj = booking.toObject();
        // Only expose OTP during the valid window with buffer for clock skew
        if (!obj.validFrom || !obj.validTo || now < new Date(obj.validFrom.getTime() - bufferMs) || now > new Date(obj.validTo.getTime() + bufferMs)) {
          delete obj.otp;
        }

        return {
          ...obj,
          qrDataUrl: await QRCode.toDataURL(booking.qrToken),
        };
      })
    );

    return res.json({ bookings: bookingsWithQr });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/bookings/verify', authRequired, conductorOrAdmin, async (req, res) => {
  try {
    const { bookingId: bodyId, qrToken: bodyToken, otp: bodyOtp } = req.body || {};
    const { bookingId: queryId, qrToken: queryToken, otp: queryOtp } = req.query || {};

    const bookingId = bodyId || queryId;
    const qrToken = bodyToken || queryToken;
    const otp = bodyOtp || queryOtp;

    console.log('Verification request received:', {
      body: req.body,
      query: req.query,
      resolved: { bookingId, qrToken }
    });

    if (!bookingId && !qrToken && !otp) {
      return res.status(400).json({ 
        message: 'Booking ID, QR token, or OTP is required for verification.',
        debug: { receivedBody: req.body, receivedQuery: req.query }
      });
    }

    let booking = null;

    if (otp) {
      // Prefer direct lookup by ID if provided
      if (bookingId) {
        booking = await Booking.findById(bookingId).populate('bus').populate('user', 'name email role');
        if (!booking || String(booking.otp) !== String(otp)) {
          return res.status(404).json({ message: 'Booking with provided OTP not found' });
        }
      } else {
        const now = new Date();
        booking = await Booking.findOne({ otp: String(otp), validFrom: { $lte: now }, validTo: { $gte: now } }).populate('bus').populate('user', 'name email role');
        if (!booking) {
          return res.status(404).json({ message: 'Active booking with provided OTP not found' });
        }
      }
    } else {
      let offlineTicketPayload = null;
      if (typeof qrToken === 'string' && qrToken.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(qrToken);
          if (parsed?.type === 'offline-ticket') {
            offlineTicketPayload = parsed;
          }
        } catch {
          offlineTicketPayload = null;
        }
      }

      if (offlineTicketPayload) {
        const ticketId = String(offlineTicketPayload.id || '').trim();
        if (!ticketId) {
          return res.status(400).json({ message: 'Offline ticket is missing ticket id' });
        }

        const existingOfflineBooking = await Booking.findOne({ offlineRef: ticketId }).populate('bus').populate('user', 'name email role');
        if (existingOfflineBooking) {
          const qrDataUrl = await QRCode.toDataURL(existingOfflineBooking.qrToken);
          return res.status(400).json({
            message: 'Offline ticket already verified',
            booking: {
              ...existingOfflineBooking.toObject(),
              qrDataUrl,
            },
          });
        }

        const busId = String(offlineTicketPayload.busId || '').trim();
        const bus = busId ? await Bus.findById(busId) : null;
        if (!bus) {
          return res.status(400).json({ message: 'Bus in offline ticket not found in database' });
        }

        const validFrom = new Date(offlineTicketPayload.validFrom);
        const validTo = new Date(offlineTicketPayload.validTo);
        if (isNaN(validFrom.getTime()) || isNaN(validTo.getTime())) {
          return res.status(400).json({ message: 'Offline ticket has invalid validity window' });
        }

        const now = new Date();
        if (now < validFrom || now > validTo) {
          return res.status(400).json({ message: 'Ticket is outside the valid travel window' });
        }

        const seatsRequested = Number(offlineTicketPayload.seats || 1);
        if (!Number.isInteger(seatsRequested) || seatsRequested < 1) {
          return res.status(400).json({ message: 'Offline ticket seats value is invalid' });
        }

        const offlineQrToken = createQrToken('offline-ticket', ticketId);
        const offlineBooking = await Booking.create({
          bus: bus._id,
          user: null,
          travelDate: String(offlineTicketPayload.travelDate || '').trim() || validFrom.toISOString().slice(0, 10),
          timingLabel: String(offlineTicketPayload.timingLabel || '').trim() || `${bus.startTime} - ${bus.endTime}`,
          startStop: String(offlineTicketPayload.startStop || '').trim() || bus.stops?.[0] || 'Unknown',
          endStop: String(offlineTicketPayload.endStop || '').trim() || bus.stops?.[bus.stops.length - 1] || 'Unknown',
          seats: seatsRequested,
          otp: String(offlineTicketPayload.otp || createOtp()),
          qrToken: offlineQrToken,
          status: 'verified',
          validFrom,
          validTo,
          verifiedAt: now,
          offlineMode: true,
          offlineRef: ticketId,
          offlinePayload: offlineTicketPayload,
        });

        booking = await Booking.findById(offlineBooking._id).populate('bus').populate('user', 'name email role');
        const qrDataUrl = await QRCode.toDataURL(offlineQrToken);
        return res.json({
          message: 'Offline ticket verified and stored',
          booking: {
            ...booking.toObject(),
            qrDataUrl,
          },
        });
      }

      const normalizedQrToken = qrToken && !qrToken.startsWith('ticket:') ? `ticket:${qrToken}` : qrToken;
      booking = bookingId
        ? await Booking.findById(bookingId).populate('bus').populate('user', 'name email role')
        : await Booking.findOne({ qrToken: normalizedQrToken }).populate('bus').populate('user', 'name email role');
    }

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.status === 'verified') {
      const qrDataUrl = await QRCode.toDataURL(booking.qrToken);
      return res.status(400).json({ message: 'Ticket already verified', booking: { ...booking.toObject(), qrDataUrl } });
    }

    const now = new Date();
    // Add 5 minute buffer to account for clock skew between client and server
    const bufferMs = 5 * 60 * 1000;
    if (now < new Date(booking.validFrom.getTime() - bufferMs) || now > new Date(booking.validTo.getTime() + bufferMs)) {
      return res.status(400).json({ message: 'Ticket is outside the valid travel window' });
    }

    booking.status = 'verified';
    booking.verifiedAt = now;
    await booking.save();

    const qrDataUrl = await QRCode.toDataURL(booking.qrToken);
    return res.json({
      booking: {
        ...booking.toObject(),
        qrDataUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Sync offline booking - allows users to sync offline tickets when going online
app.post('/api/bookings/sync-offline', authRequired, async (req, res) => {
  try {
    const ticket = req.body || {};
    const userId = req.auth.id;

    // Validate required fields from offline ticket
    const ticketId = String(ticket.id || '').trim();
    const busId = String(ticket.busId || '').trim();
    const otp = String(ticket.otp || '').trim();

    if (!ticketId || !busId || !otp) {
      return res.status(400).json({ message: 'Offline ticket is missing required fields (id, busId, otp)' });
    }

    // Check if already synced (by offlineRef)
    const existing = await Booking.findOne({ offlineRef: ticketId }).populate('bus').populate('user', 'name email role');
    if (existing) {
      const qrDataUrl = await QRCode.toDataURL(existing.qrToken);
      return res.json({
        message: 'Offline ticket already synced',
        booking: {
          ...existing.toObject(),
          qrDataUrl,
        },
      });
    }

    // Get bus details
    const bus = await Bus.findById(busId);
    if (!bus) {
      return res.status(400).json({ message: 'Bus not found in database' });
    }

    // Validate ticket validity window
    const validFrom = new Date(ticket.validFrom);
    const validTo = new Date(ticket.validTo);
    if (isNaN(validFrom.getTime()) || isNaN(validTo.getTime())) {
      return res.status(400).json({ message: 'Offline ticket has invalid validity window' });
    }

    const now = new Date();
    if (now > validTo) {
      return res.status(400).json({ message: 'Offline ticket has expired' });
    }

    // Validate seats
    const seats = Number(ticket.seats || 1);
    if (!Number.isInteger(seats) || seats < 1) {
      return res.status(400).json({ message: 'Invalid seats value' });
    }

    // Create booking for this user
    const qrToken = createQrToken('ticket', ticketId);
    const booking = await Booking.create({
      bus: bus._id,
      user: userId,
      travelDate: String(ticket.travelDate || '').trim() || validFrom.toISOString().slice(0, 10),
      timingLabel: String(ticket.timingLabel || '').trim() || `${bus.startTime} - ${bus.endTime}`,
      startStop: String(ticket.startStop || '').trim() || (bus.stops?.[0]?.name || bus.stops?.[0] || 'Unknown'),
      endStop: String(ticket.endStop || '').trim() || (bus.stops?.[bus.stops.length - 1]?.name || bus.stops?.[bus.stops.length - 1] || 'Unknown'),
      seats,
      otp,
      qrToken,
      status: now >= validFrom ? 'verified' : 'pending',
      validFrom,
      validTo,
      verifiedAt: now >= validFrom ? now : null,
      offlineMode: true,
      offlineRef: ticketId,
      offlinePayload: ticket,
    });

    const populated = await Booking.findById(booking._id).populate('bus').populate('user', 'name email role');
    const qrDataUrl = await QRCode.toDataURL(qrToken);

    return res.status(201).json({
      message: 'Offline ticket synced successfully',
      booking: {
        ...populated.toObject(),
        qrDataUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Bus booking API running on port ${port}`);
});