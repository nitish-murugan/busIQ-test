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
    role: { type: String, enum: ['user', 'admin'], required: true },
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
    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    stops: [{ type: String, trim: true }],
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
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);
const Bus = mongoose.model('Bus', busSchema);
const Booking = mongoose.model('Booking', bookingSchema);

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
  return jwt.sign({ id: user._id.toString(), role: user.role }, jwtSecret, { expiresIn: '7d' });
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

function createOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createQrToken(prefix, id) {
  return `${prefix}:${id}`;
}

function parseTime(dateValue, timeValue) {
  if (!timeValue) return new Date(dateValue);

  const str = String(timeValue).trim();
  // Match formats like '8:00', '08:00', '8:00 AM', '08:00PM', case-insensitive
  const m = str.match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);
  if (m) {
    let hours = Number(m[1]);
    const minutes = Number(m[2]);
    const period = m[3] ? m[3].toUpperCase() : null;

    if (period) {
      if (period === 'AM') {
        if (hours === 12) hours = 0;
      } else if (period === 'PM') {
        if (hours !== 12) hours += 12;
      }
    }

    const date = new Date(dateValue);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  // Fallback: try constructing from combined date+time string
  const fallback = new Date(`${dateValue} ${str}`);
  if (!isNaN(fallback.getTime())) return fallback;

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

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Role must be user or admin' });
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

app.get('/api/buses', authRequired, async (req, res) => {
  try {
    const { number } = req.query;

    if (number) {
      const bus = await Bus.findOne({ busNumber: number.trim() }).populate('createdBy', 'name email role');
      if (!bus) {
        return res.json({ bus: null });
      }

      const qrDataUrl = await QRCode.toDataURL(createQrToken('bus', bus._id.toString()));
      return res.json({
        bus: {
          ...bus.toObject(),
          qrDataUrl,
        },
      });
    }

    const buses = await Bus.find().sort({ createdAt: -1 });
    const busesWithQr = await Promise.all(
      buses.map(async (bus) => ({
        ...bus.toObject(),
        qrDataUrl: await QRCode.toDataURL(createQrToken('bus', bus._id.toString())),
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

    const qrDataUrl = await QRCode.toDataURL(createQrToken('bus', bus._id.toString()));
    return res.json({
      bus: {
        ...bus.toObject(),
        qrDataUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/buses', authRequired, adminOnly, async (req, res) => {
  try {
    const { busNumber, seats, startTime, endTime, startPeriod, endPeriod, daily, from, to, stops } = req.body || {};
    const cleanStops = Array.isArray(stops) ? stops.map((stop) => String(stop).trim()).filter(Boolean) : [];

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
      from: from.trim(),
      to: to.trim(),
      stops: cleanStops,
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

    const qrDataUrl = await QRCode.toDataURL(bus.qrToken);

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

    const startIndex = bus.stops.indexOf(startStop);
    const endIndex = bus.stops.indexOf(endStop);

    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      return res.status(400).json({ message: 'Choose a valid start and end stop in route order' });
    }

    const seatsRequested = Number(seats);
    if (!Number.isInteger(seatsRequested) || seatsRequested < 1 || seatsRequested > bus.seats) {
      return res.status(400).json({ message: `Seats must be between 1 and ${bus.seats}` });
    }

    const [startTime, endTime] = timingLabel.split(' - ');
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
    // Only expose OTP during the valid window
    if (!bookingObj.validFrom || !bookingObj.validTo || now < bookingObj.validFrom || now > bookingObj.validTo) {
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
    const bookingsWithQr = await Promise.all(
      bookings.map(async (booking) => {
        const obj = booking.toObject();
        // Only expose OTP during the valid window
        if (!obj.validFrom || !obj.validTo || now < obj.validFrom || now > obj.validTo) {
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

app.post('/api/bookings/verify', authRequired, adminOnly, async (req, res) => {
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
    if (now < booking.validFrom || now > booking.validTo) {
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Bus booking API running on port ${port}`);
});