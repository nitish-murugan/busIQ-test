import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, NativeModules, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';

function extractHost(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  const withoutScheme = normalized.replace(/^https?:\/\//, '').replace(/^exp:\/\//, '');
  const hostPart = withoutScheme.split('/')[0];
  const hostOnly = hostPart.split(':')[0];

  if (!hostOnly || hostOnly === 'localhost' || hostOnly === '127.0.0.1' || hostOnly.includes('expo') || hostOnly.includes('localhost')) {
    return null;
  }

  return hostOnly;
}

function resolveApiBaseUrls() {
  const configuredBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim().replace(/\/$/, '');
  if (configuredBaseUrl) {
    return [configuredBaseUrl];
  }

  const runtimeHostCandidates = [
    Constants.expoConfig?.hostUri,
    Constants.manifest?.debuggerHost,
    Constants.manifest2?.extra?.expoClient?.hostUri,
    NativeModules.SourceCode?.scriptURL,
  ];

  const host = runtimeHostCandidates.map(extractHost).find(Boolean);
  const hostUrl = host && host !== 'localhost' && host !== '127.0.0.1' ? `http://${host}:4000/api` : null;

  return [
    hostUrl,
    Platform.OS === 'android' ? 'http://10.0.2.2:4000/api' : null,
    'http://localhost:4000/api',
  ].filter(Boolean);
}

const API_BASE_URLS = resolveApiBaseUrls();

const authInitialState = {
  name: '',
  email: '',
  password: '',
  role: 'user',
};

const busInitialState = {
  busNumber: '',
  seats: '40',
  startTime: '08:00',
  endTime: '12:00',
  startPeriod: 'AM',
  endPeriod: 'PM',
  daily: true,
  from: '',
  to: '',
  stops: ['', ''],
};

const bookingInitialState = {
  travelDate: new Date().toISOString().slice(0, 10),
  timingLabel: '',
  startStop: '',
  endStop: '',
  seats: '1',
};

function currencyText(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

function humanTimeRange(startTime, endTime) {
  return `${startTime} - ${endTime}`;
}

function formatDateTime(dateValue) {
  const date = new Date(dateValue);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function parseQrData(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }

  if (rawValue.startsWith('bus:')) {
    return { type: 'bus', id: rawValue.slice(4) };
  }

  if (rawValue.startsWith('ticket:')) {
    return { type: 'ticket', id: rawValue.slice(7) };
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (parsed?.type && parsed?.id) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function requestJson(path, { method = 'GET', body, token } = {}) {
  let lastNetworkError = null;
  const triedBaseUrls = [];

  console.log(`[requestJson] ${method} ${path}`, { body, hasToken: !!token });

  for (const baseUrl of API_BASE_URLS) {
    try {
      triedBaseUrls.push(baseUrl);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.message || 'Something went wrong');
      }

      return data;
    } catch (error) {
      const isNetworkError = String(error?.message || '').includes('Network request failed') || String(error?.message || '').includes('Failed to fetch');

      if (!isNetworkError) {
        throw error;
      }

      lastNetworkError = error;
    }
  }

  const attempted = triedBaseUrls.length ? ` Tried: ${triedBaseUrls.join(', ')}.` : '';
  throw new Error(`Backend unreachable from Expo Go.${attempted} Start the backend with the app, then use your laptop LAN IP in EXPO_PUBLIC_API_BASE_URL if you are on a physical device.`.trim() || lastNetworkError?.message || 'Network request failed');
}

function AppHeader({ session, onLogout }) {
  return (
    <View style={styles.headerCard}>
      <View>
        <Text style={styles.kicker}>Bus Booking Platform</Text>
        <Text style={styles.title}>RouteFlow</Text>
        <Text style={styles.subtitle}>Admin bus management, QR ticketing, and user booking in one clean workspace.</Text>
      </View>
      {session ? (
        <View style={styles.headerRight}>
          <Text style={styles.roleBadge}>{session.user.role.toUpperCase()}</Text>
          <Text style={styles.headerMeta}>{session.user.name}</Text>
          <Pressable style={styles.ghostButton} onPress={onLogout}>
            <Text style={styles.ghostButtonText}>Logout</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function Field({ label, value, onChangeText, placeholder, keyboardType = 'default', secureTextEntry = false, multiline = false }) {
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#94A3B8"
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        style={[styles.input, multiline && styles.textArea]}
      />
    </View>
  );
}

function PillButton({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress, loading = false, style }) {
  return (
    <Pressable onPress={onPress} disabled={loading} style={[styles.primaryButton, loading && styles.primaryButtonDisabled, style]}>
      <Text style={styles.primaryButtonText}>{loading ? 'Please wait...' : label}</Text>
    </Pressable>
  );
}

function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function SectionTitle({ title, description }) {
  return (
    <View style={styles.sectionTitleWrap}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {description ? <Text style={styles.sectionDescription}>{description}</Text> : null}
    </View>
  );
}

function ScannerPanel({ purpose, onClose, onMatch, label, description }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    setLocked(false);
  }, [purpose]);

  const handleBarcodeScanned = ({ data }) => {
    if (locked) {
      return;
    }

    const parsed = parseQrData(data);
    if (!parsed) {
      Alert.alert('Invalid QR', 'This QR code is not recognized by the app.');
      return;
    }

    setLocked(true);
    onMatch(parsed, data);
  };

  if (!permission) {
    return <View style={styles.scannerPermissionWrap} />;
  }

  if (!permission.granted) {
    return (
      <Card style={styles.scannerCard}>
        <Text style={styles.cardTitle}>{label}</Text>
        <Text style={styles.cardSubtitle}>{description}</Text>
        <PrimaryButton label="Grant Camera Permission" onPress={requestPermission} />
        <Pressable onPress={onClose} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Close scanner</Text>
        </Pressable>
      </Card>
    );
  }

  return (
    <Card style={styles.scannerCard}>
      <View style={styles.scannerHeader}>
        <View>
          <Text style={styles.cardTitle}>{label}</Text>
          <Text style={styles.cardSubtitle}>{description}</Text>
        </View>
        <Pressable onPress={onClose} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Close</Text>
        </Pressable>
      </View>
      <View style={styles.cameraFrame}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <View style={styles.cameraOverlay}>
          <View style={styles.scanCorner} />
          <View style={[styles.scanCorner, styles.scanCornerTopRight]} />
          <View style={[styles.scanCorner, styles.scanCornerBottomLeft]} />
          <View style={[styles.scanCorner, styles.scanCornerBottomRight]} />
        </View>
      </View>
      <Text style={styles.helperText}>Point the camera at a QR code that was generated in this app.</Text>
    </Card>
  );
}

function BusDetailsCard({ bus, onStartBooking, hideActions = false }) {
  if (!bus) {
    return null;
  }

  return (
    <Card>
      <View style={styles.busTopRow}>
        <View>
          <Text style={styles.cardTitle}>Bus {bus.busNumber}</Text>
          <Text style={styles.cardSubtitle}>{bus.from} to {bus.to}</Text>
        </View>
        <Text style={styles.seatsBadge}>{bus.seats} seats</Text>
      </View>
      <View style={styles.infoRow}>
        <View style={styles.infoPill}><Text style={styles.infoLabel}>Timing</Text><Text style={styles.infoValue}>{humanTimeRange(bus.startTime, bus.endTime)}</Text></View>
        <View style={styles.infoPill}><Text style={styles.infoLabel}>Type</Text><Text style={styles.infoValue}>{bus.daily ? 'Daily' : 'Scheduled'}</Text></View>
      </View>
      <Text style={styles.sectionMiniLabel}>Stops</Text>
      <View style={styles.stopWrap}>
        {(bus.stops || []).map((stop) => (
          <View key={stop} style={styles.stopChip}>
            <Text style={styles.stopChipText}>{stop}</Text>
          </View>
        ))}
      </View>
      {bus.qrDataUrl ? <Image source={{ uri: bus.qrDataUrl }} style={styles.busQrImage} /> : null}
      {!hideActions && onStartBooking ? (
        <PrimaryButton label="Book this bus" onPress={onStartBooking} style={styles.busActionButton} />
      ) : null}
    </Card>
  );
}

function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(authInitialState);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    try {
      setLoading(true);
      const payload = {
        email: form.email.trim(),
        password: form.password,
      };

      if (mode === 'register') {
        payload.name = form.name.trim();
        payload.role = form.role;
      }

      const data = await requestJson(`/auth/${mode}`, {
        method: 'POST',
        body: payload,
      });

      onAuthed(data);
    } catch (error) {
      Alert.alert('Authentication failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Card style={styles.authCard}>
        <View style={styles.modeTabs}>
          <PillButton label="Login" active={mode === 'login'} onPress={() => setMode('login')} />
          <PillButton label="Register" active={mode === 'register'} onPress={() => setMode('register')} />
        </View>
        <Text style={styles.authHeading}>{mode === 'login' ? 'Welcome back' : 'Create your account'}</Text>
        <Text style={styles.authText}>Use the same app for users and admins. Register once, then sign in with your role.</Text>
        {mode === 'register' ? (
          <Field label="Full name" value={form.name} onChangeText={(name) => setForm((current) => ({ ...current, name }))} placeholder="John Carter" />
        ) : null}
        <Field label="Email" value={form.email} onChangeText={(email) => setForm((current) => ({ ...current, email }))} placeholder="you@company.com" keyboardType="email-address" />
        <Field label="Password" value={form.password} onChangeText={(password) => setForm((current) => ({ ...current, password }))} placeholder="••••••••" secureTextEntry />
        {mode === 'register' ? (
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Role</Text>
            <View style={styles.modeTabs}>
              <PillButton label="User" active={form.role === 'user'} onPress={() => setForm((current) => ({ ...current, role: 'user' }))} />
              <PillButton label="Admin" active={form.role === 'admin'} onPress={() => setForm((current) => ({ ...current, role: 'admin' }))} />
            </View>
          </View>
        ) : null}
        <PrimaryButton label={mode === 'login' ? 'Login' : 'Register'} onPress={submit} loading={loading} />
      </Card>
      <Card style={styles.featureGrid}>
        <View style={styles.featureItem}>
          <Text style={styles.featureLabel}>Admin</Text>
          <Text style={styles.featureValue}>Add buses, manage stops, and verify QR tickets.</Text>
        </View>
        <View style={styles.featureItem}>
          <Text style={styles.featureLabel}>User</Text>
          <Text style={styles.featureValue}>Search by bus number, scan bus QR, and book instantly.</Text>
        </View>
      </Card>
    </ScrollView>
  );
}

function UserDashboard({ session, onLogout }) {
  const [activeTab, setActiveTab] = useState('search');
  const [searchValue, setSearchValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [bookingForm, setBookingForm] = useState(bookingInitialState);
  const [tickets, setTickets] = useState([]);
  const [selectedTicketId, setSelectedTicketId] = useState(null);

  const loadMyBookings = async () => {
    try {
      const data = await requestJson('/bookings/me', {
        token: session.token,
      });

      const myTickets = data.bookings || [];
      setTickets(myTickets);
      setSelectedTicketId((current) => current || myTickets[0]?._id || null);
    } catch (error) {
      Alert.alert('Could not load tickets', error.message);
    }
  };

  useEffect(() => {
    loadMyBookings();
  }, [session.token]);

  const fetchBus = async (busNumber) => {
    if (!busNumber.trim()) {
      Alert.alert('Search bus', 'Enter a bus number first.');
      return;
    }

    try {
      setLoading(true);
      const data = await requestJson(`/buses?number=${encodeURIComponent(busNumber.trim())}`, {
        token: session.token,
      });

      setSelectedBus(data.bus || null);

      if (!data.bus) {
        Alert.alert('No bus found', 'No bus matched that number.');
      } else {
        setBookingForm((current) => ({
          ...current,
          timingLabel: data.bus.timings?.[0]?.label || humanTimeRange(data.bus.startTime, data.bus.endTime),
          startStop: data.bus.stops?.[0] || '',
          endStop: data.bus.stops?.[data.bus.stops.length - 1] || '',
        }));
      }
    } catch (error) {
      Alert.alert('Search failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBusScan = async ({ id }) => {
    try {
      setLoading(true);
      const data = await requestJson(`/buses/${id}`, { token: session.token });
      setSelectedBus(data.bus);
      setScannerOpen(false);
      setActiveTab('search');
      setBookingForm((current) => ({
        ...current,
        timingLabel: data.bus.timings?.[0]?.label || humanTimeRange(data.bus.startTime, data.bus.endTime),
        startStop: data.bus.stops?.[0] || '',
        endStop: data.bus.stops?.[data.bus.stops.length - 1] || '',
      }));
    } catch (error) {
      Alert.alert('QR scan failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const createBooking = async () => {
    try {
      setLoading(true);
      const data = await requestJson('/bookings', {
        method: 'POST',
        token: session.token,
        body: {
          busId: selectedBus._id,
          travelDate: bookingForm.travelDate,
          timingLabel: bookingForm.timingLabel,
          startStop: bookingForm.startStop,
          endStop: bookingForm.endStop,
          seats: Number(bookingForm.seats),
        },
      });

      setTickets((current) => [data.booking, ...current.filter((ticketItem) => ticketItem._id !== data.booking._id)]);
      setSelectedTicketId(data.booking._id);
      setSelectedBus(data.booking.bus);
      setActiveTab('ticket');
    } catch (error) {
      Alert.alert('Booking failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const selectedTicket = useMemo(() => {
    if (!tickets.length) {
      return null;
    }

    if (!selectedTicketId) {
      return tickets[0];
    }

    return tickets.find((ticketItem) => ticketItem._id === selectedTicketId) || tickets[0];
  }, [tickets, selectedTicketId]);

  const ticketValidity = useMemo(() => {
    if (!selectedTicket) {
      return '';
    }

    return `${formatDateTime(selectedTicket.validFrom)} - ${formatDateTime(selectedTicket.validTo)}`;
  }, [selectedTicket]);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <AppHeader session={session} onLogout={onLogout} />

      <View style={styles.tabRow}>
        <PillButton label="Search bus" active={activeTab === 'search'} onPress={() => setActiveTab('search')} />
        <PillButton label="Ticket" active={activeTab === 'ticket'} onPress={() => setActiveTab('ticket')} />
        <PillButton label="Scan bus" active={scannerOpen} onPress={() => setScannerOpen(true)} />
      </View>

      {activeTab === 'search' ? (
        <Card>
          <SectionTitle title="Find your route" description="Search by bus number or scan the bus QR to load its stops and schedule." />
          <Field label="Bus number" value={searchValue} onChangeText={setSearchValue} placeholder="BUS-101" />
          <View style={styles.rowButtons}>
            <PrimaryButton label="Search bus" onPress={() => fetchBus(searchValue)} loading={loading} style={styles.flexButton} />
            <Pressable
              style={styles.secondaryAction}
              onPress={() => {
                setScannerOpen(true);
              }}
            >
              <Text style={styles.secondaryActionText}>Scan QR</Text>
            </Pressable>
          </View>
          {selectedBus ? <BusDetailsCard bus={selectedBus} onStartBooking={() => setActiveTab('ticket')} /> : <Text style={styles.helperText}>Search a bus to start a booking.</Text>}
        </Card>
      ) : null}

      {selectedBus ? (
        <Card>
          <SectionTitle title="Book seat" description="Choose date, timing, start stop, end stop, and seat count." />
          <View style={styles.infoRow}>
            {(selectedBus.timings || [{ label: humanTimeRange(selectedBus.startTime, selectedBus.endTime) }]).map((timing) => (
              <PillButton
                key={timing.label}
                label={timing.label}
                active={bookingForm.timingLabel === timing.label}
                onPress={() => setBookingForm((current) => ({ ...current, timingLabel: timing.label }))}
              />
            ))}
          </View>
          <Field label="Travel date" value={bookingForm.travelDate} onChangeText={(travelDate) => setBookingForm((current) => ({ ...current, travelDate }))} placeholder="YYYY-MM-DD" />
          <Field label="Seats" value={bookingForm.seats} onChangeText={(seats) => setBookingForm((current) => ({ ...current, seats }))} keyboardType="number-pad" placeholder="1" />

          <Text style={styles.sectionMiniLabel}>Start stop</Text>
          <View style={styles.stopWrap}>
            {(selectedBus.stops || []).map((stop) => (
              <PillButton key={`start-${stop}`} label={stop} active={bookingForm.startStop === stop} onPress={() => setBookingForm((current) => ({ ...current, startStop: stop }))} />
            ))}
          </View>

          <Text style={styles.sectionMiniLabel}>End stop</Text>
          <View style={styles.stopWrap}>
            {(selectedBus.stops || []).map((stop) => (
              <PillButton key={`end-${stop}`} label={stop} active={bookingForm.endStop === stop} onPress={() => setBookingForm((current) => ({ ...current, endStop: stop }))} />
            ))}
          </View>

          <PrimaryButton label={`Just Pay ${currencyText(Number(bookingForm.seats) * 249)}`} onPress={createBooking} loading={loading} />
        </Card>
      ) : null}

      {activeTab === 'ticket' ? (
        <Card>
          <SectionTitle title="Your tickets" description="All booked tickets are listed here. Select one to show QR and OTP." />
          {tickets.length ? (
            <>
              <View style={styles.stopWrap}>
                {tickets.map((ticketItem) => (
                  <PillButton
                    key={ticketItem._id}
                    label={`${ticketItem.bus?.busNumber || 'BUS'} • ${ticketItem.travelDate}`}
                    active={(selectedTicket?._id || '') === ticketItem._id}
                    onPress={() => setSelectedTicketId(ticketItem._id)}
                  />
                ))}
              </View>
              {selectedTicket ? (
                <>
                  <View style={styles.ticketMetaGrid}>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Booking</Text><Text style={styles.ticketMetaValue}>#{selectedTicket._id.slice(-8)}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{selectedTicket.otp}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Status</Text><Text style={styles.ticketMetaValue}>{selectedTicket.status}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Validity</Text><Text style={styles.ticketMetaValueSmall}>{ticketValidity}</Text></View>
                  </View>
                  {selectedTicket.qrDataUrl ? <Image source={{ uri: selectedTicket.qrDataUrl }} style={styles.ticketQrImage} /> : null}
                  <Text style={styles.helperText}>Route: {selectedTicket.startStop} to {selectedTicket.endStop} • Seats: {selectedTicket.seats}</Text>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Text style={styles.helperText}>No tickets booked yet. Book a bus and your ticket will appear here.</Text>
              <PrimaryButton label="Refresh tickets" onPress={loadMyBookings} />
            </>
          )}
        </Card>
      ) : null}

      {scannerOpen ? (
        <ScannerPanel
          purpose="bus"
          label="Scan bus QR"
          description="Scan a bus QR to load route details and stop list."
          onClose={() => setScannerOpen(false)}
          onMatch={handleBusScan}
        />
      ) : null}
    </ScrollView>
  );
}

function AdminDashboard({ session, onLogout }) {
  const [activeTab, setActiveTab] = useState('add');
  const [form, setForm] = useState(busInitialState);
  const [loading, setLoading] = useState(false);
  const [savedBus, setSavedBus] = useState(null);
  const [busList, setBusList] = useState([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerPurpose, setScannerPurpose] = useState('ticket');
  const [verifiedTicket, setVerifiedTicket] = useState(null);

  const refreshBuses = async () => {
    try {
      const data = await requestJson('/buses', { token: session.token });
      setBusList(data.buses || []);
    } catch (error) {
      Alert.alert('Could not load buses', error.message);
    }
  };

  useEffect(() => {
    refreshBuses();
  }, []);

  const addStop = () => {
    setForm((current) => ({ ...current, stops: [...current.stops, ''] }));
  };

  const updateStop = (index, value) => {
    setForm((current) => {
      const nextStops = [...current.stops];
      nextStops[index] = value;
      return { ...current, stops: nextStops };
    });
  };

  const saveBus = async () => {
    try {
      setLoading(true);
      const stops = form.stops.map((stop) => stop.trim()).filter(Boolean);

      const data = await requestJson('/buses', {
        method: 'POST',
        token: session.token,
        body: {
          busNumber: form.busNumber.trim(),
          seats: Number(form.seats),
          startTime: form.startTime,
          startPeriod: form.startPeriod,
          endTime: form.endTime,
          endPeriod: form.endPeriod,
          daily: form.daily,
          from: form.from.trim(),
          to: form.to.trim(),
          stops,
        },
      });

      setSavedBus(data.bus);
      setBusList((current) => [data.bus, ...current.filter((bus) => bus._id !== data.bus._id)]);
      Alert.alert('Bus saved', 'QR generated for the newly created bus.');
    } catch (error) {
      Alert.alert('Save failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTicketScan = async ({ id }, rawValue) => {
    try {
      console.log('handleTicketScan match:', { id, rawValue });
      setLoading(true);
      const data = await requestJson('/bookings/verify', {
        method: 'POST',
        token: session.token,
        body: { qrToken: rawValue || `ticket:${id}` },
      });

      setVerifiedTicket(data.booking);
      setScannerOpen(false);
      setActiveTab('verify');
    } catch (error) {
      Alert.alert('Verification failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBusScan = async ({ id }) => {
    try {
      setLoading(true);
      const data = await requestJson(`/buses/${id}`, { token: session.token });
      setSavedBus(data.bus);
      setScannerOpen(false);
      setActiveTab('add');
    } catch (error) {
      Alert.alert('Bus scan failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <AppHeader session={session} onLogout={onLogout} />
      <View style={styles.tabRow}>
        <PillButton label="Add bus" active={activeTab === 'add'} onPress={() => setActiveTab('add')} />
        <PillButton label="Verify ticket" active={activeTab === 'verify'} onPress={() => setActiveTab('verify')} />
        <PillButton label="Scan bus" active={scannerOpen && scannerPurpose === 'bus'} onPress={() => { setScannerPurpose('bus'); setScannerOpen(true); }} />
      </View>

      {activeTab === 'add' ? (
        <Card>
          <SectionTitle title="Add a bus" description="Capture the route, timings, stops, and seating once. The app creates a QR instantly." />
          <Field label="Bus number" value={form.busNumber} onChangeText={(busNumber) => setForm((current) => ({ ...current, busNumber }))} placeholder="BUS-101" />
          <View style={styles.splitRow}>
            <Field label="Seats" value={form.seats} onChangeText={(seats) => setForm((current) => ({ ...current, seats }))} keyboardType="number-pad" placeholder="40" />
            <View style={styles.switchBlock}>
              <Text style={styles.fieldLabel}>Daily service</Text>
              <View style={styles.switchRow}>
                <Text style={styles.switchText}>{form.daily ? 'Daily' : 'Special trip'}</Text>
                <Switch value={form.daily} onValueChange={(daily) => setForm((current) => ({ ...current, daily }))} />
              </View>
            </View>
          </View>
          <View style={styles.splitRow}>
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Start time</Text>
              <View style={styles.timeRow}>
                <TextInput
                  value={form.startTime}
                  onChangeText={(startTime) => setForm((current) => ({ ...current, startTime }))}
                  placeholder="08:00"
                  placeholderTextColor="#94A3B8"
                  style={[styles.input, styles.timeInput]}
                />
                <Pressable style={styles.periodPicker} onPress={() => setForm((current) => ({ ...current, startPeriod: current.startPeriod === 'AM' ? 'PM' : 'AM' }))}>
                  <Text style={styles.periodText}>{form.startPeriod || 'AM'}</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>End time</Text>
              <View style={styles.timeRow}>
                <TextInput
                  value={form.endTime}
                  onChangeText={(endTime) => setForm((current) => ({ ...current, endTime }))}
                  placeholder="12:00"
                  placeholderTextColor="#94A3B8"
                  style={[styles.input, styles.timeInput]}
                />
                <Pressable style={styles.periodPicker} onPress={() => setForm((current) => ({ ...current, endPeriod: current.endPeriod === 'AM' ? 'PM' : 'AM' }))}>
                  <Text style={styles.periodText}>{form.endPeriod || 'PM'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
          <View style={styles.splitRow}>
            <Field label="From" value={form.from} onChangeText={(from) => setForm((current) => ({ ...current, from }))} placeholder="City A" />
            <Field label="To" value={form.to} onChangeText={(to) => setForm((current) => ({ ...current, to }))} placeholder="City B" />
          </View>
          <Text style={styles.sectionMiniLabel}>Stops</Text>
          {form.stops.map((stop, index) => (
            <Field key={`stop-${index}`} label={`Stop ${index + 1}`} value={stop} onChangeText={(value) => updateStop(index, value)} placeholder={`Stop ${index + 1}`} />
          ))}
          <View style={styles.rowButtons}>
            <Pressable style={styles.secondaryAction} onPress={addStop}>
              <Text style={styles.secondaryActionText}>Add stop</Text>
            </Pressable>
            <PrimaryButton label="Save bus" onPress={saveBus} loading={loading} style={styles.flexButton} />
          </View>
          {savedBus ? <BusDetailsCard bus={savedBus} hideActions /> : null}
        </Card>
      ) : null}

      {activeTab === 'verify' ? (
        <Card>
          <SectionTitle title="Verify ticket" description="Scan a passenger QR and confirm that the booking is still within the selected route window." />
          {verifiedTicket ? (
            <View style={styles.ticketMetaGrid}>
              <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Ticket</Text><Text style={styles.ticketMetaValue}>#{verifiedTicket._id.slice(-8)}</Text></View>
              <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Status</Text><Text style={styles.ticketMetaValue}>{verifiedTicket.status}</Text></View>
              <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{verifiedTicket.otp}</Text></View>
              <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Route</Text><Text style={styles.ticketMetaValueSmall}>{verifiedTicket.startStop} → {verifiedTicket.endStop}</Text></View>
            </View>
          ) : (
            <Text style={styles.helperText}>Use the scanner to verify an active ticket.</Text>
          )}
          <PrimaryButton label="Open ticket scanner" onPress={() => { setScannerPurpose('ticket'); setScannerOpen(true); }} />
        </Card>
      ) : null}

      {scannerOpen ? (
        <ScannerPanel
          purpose={scannerPurpose}
          label={scannerPurpose === 'bus' ? 'Scan bus QR' : 'Scan ticket QR'}
          description={scannerPurpose === 'bus' ? 'Scan a bus QR to view route details and stop list.' : 'Scan a ticket QR to verify a passenger booking.'}
          onClose={() => setScannerOpen(false)}
          onMatch={scannerPurpose === 'bus' ? handleBusScan : handleTicketScan}
        />
      ) : null}

      <Card>
        <SectionTitle title="Recent buses" description="Quick access to routes already stored in the local MongoDB collection." />
        {busList.length ? busList.map((bus) => <BusDetailsCard key={bus._id} bus={bus} hideActions />) : <Text style={styles.helperText}>No buses saved yet.</Text>}
      </Card>
    </ScrollView>
  );
}

export default function App() {
  const [session, setSession] = useState(null);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />
      <View style={styles.bgBlobOne} />
      <View style={styles.bgBlobTwo} />
      <ScrollView contentContainerStyle={styles.screenContent}>
        {!session ? (
          <>
            <AppHeader />
            <AuthScreen onAuthed={setSession} />
          </>
        ) : session.user.role === 'admin' ? (
          <AdminDashboard session={session} onLogout={() => setSession(null)} />
        ) : (
          <UserDashboard session={session} onLogout={() => setSession(null)} />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#07111F',
  },
  screenContent: {
    flexGrow: 1,
    padding: 16,
    gap: 16,
  },
  scrollContent: {
    paddingBottom: 28,
    gap: 16,
  },
  bgBlobOne: {
    position: 'absolute',
    top: -60,
    right: -40,
    width: 180,
    height: 180,
    borderRadius: 180,
    backgroundColor: 'rgba(0, 194, 255, 0.18)',
  },
  bgBlobTwo: {
    position: 'absolute',
    bottom: 120,
    left: -50,
    width: 220,
    height: 220,
    borderRadius: 220,
    backgroundColor: 'rgba(255, 186, 73, 0.12)',
  },
  headerCard: {
    backgroundColor: '#081427',
    borderRadius: 28,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 6,
    gap: 16,
  },
  kicker: {
    color: '#7DD3FC',
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 34,
    fontWeight: '800',
  },
  subtitle: {
    color: '#CBD5E1',
    marginTop: 8,
    lineHeight: 20,
  },
  headerRight: {
    alignItems: 'flex-start',
    gap: 8,
  },
  headerMeta: {
    color: '#E2E8F0',
    fontWeight: '700',
  },
  roleBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#123055',
    color: '#7DD3FC',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: 'rgba(125, 211, 252, 0.35)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
  },
  ghostButtonText: {
    color: '#BAE6FD',
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#F8FAFC',
    borderRadius: 24,
    padding: 18,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 4,
  },
  authCard: {
    marginTop: 6,
  },
  modeTabs: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#E2E8F0',
  },
  pillActive: {
    backgroundColor: '#0F172A',
  },
  pillText: {
    color: '#334155',
    fontWeight: '700',
  },
  pillTextActive: {
    color: '#F8FAFC',
  },
  authHeading: {
    color: '#0F172A',
    fontSize: 24,
    fontWeight: '800',
  },
  authText: {
    color: '#475569',
    lineHeight: 20,
  },
  fieldBlock: {
    gap: 8,
    flex: 1,
  },
  timeRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  timeInput: {
    flex: 1,
  },
  periodPicker: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  periodText: {
    color: '#0F172A',
    fontWeight: '800',
  },
  fieldLabel: {
    color: '#0F172A',
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    color: '#0F172A',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  textArea: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  primaryButton: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.72,
  },
  primaryButtonText: {
    color: '#F8FAFC',
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  featureGrid: {
    backgroundColor: '#0B1220',
  },
  featureItem: {
    gap: 4,
  },
  featureLabel: {
    color: '#7DD3FC',
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  featureValue: {
    color: '#E2E8F0',
    lineHeight: 20,
  },
  sectionTitleWrap: {
    gap: 6,
  },
  sectionTitle: {
    color: '#0F172A',
    fontSize: 20,
    fontWeight: '800',
  },
  sectionDescription: {
    color: '#64748B',
    lineHeight: 20,
  },
  cardTitle: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '800',
  },
  cardSubtitle: {
    color: '#64748B',
    lineHeight: 20,
  },
  qrCard: {
    alignItems: 'center',
  },
  qrImage: {
    width: 180,
    height: 180,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
  },
  qrPlaceholder: {
    width: 180,
    height: 180,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
  },
  qrPlaceholderText: {
    color: '#64748B',
    fontWeight: '700',
  },
  scannerCard: {
    gap: 14,
  },
  scannerPermissionWrap: {
    minHeight: 120,
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  cameraFrame: {
    borderRadius: 24,
    overflow: 'hidden',
    height: 320,
    backgroundColor: '#0F172A',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  scanCorner: {
    position: 'absolute',
    top: 14,
    left: 14,
    width: 42,
    height: 42,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderColor: '#7DD3FC',
    borderTopLeftRadius: 18,
  },
  scanCornerTopRight: {
    left: 'auto',
    right: 14,
    borderLeftWidth: 0,
    borderRightWidth: 4,
    borderTopRightRadius: 18,
  },
  scanCornerBottomLeft: {
    top: 'auto',
    bottom: 14,
    borderTopWidth: 0,
    borderBottomWidth: 4,
    borderBottomLeftRadius: 18,
  },
  scanCornerBottomRight: {
    top: 'auto',
    bottom: 14,
    left: 'auto',
    right: 14,
    borderTopWidth: 0,
    borderLeftWidth: 0,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderBottomRightRadius: 18,
  },
  helperText: {
    color: '#64748B',
    lineHeight: 20,
  },
  rowButtons: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  flexButton: {
    flexGrow: 1,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0F172A',
    fontWeight: '700',
  },
  secondaryAction: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  secondaryActionText: {
    color: '#0F172A',
    fontWeight: '700',
  },
  busTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  seatsBadge: {
    backgroundColor: '#DCFCE7',
    color: '#166534',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    fontWeight: '800',
  },
  infoRow: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  infoPill: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    minWidth: 132,
    gap: 2,
  },
  infoLabel: {
    color: '#64748B',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  infoValue: {
    color: '#0F172A',
    fontWeight: '700',
  },
  sectionMiniLabel: {
    color: '#0F172A',
    fontWeight: '800',
    marginTop: 4,
  },
  stopWrap: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  stopChip: {
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  stopChipText: {
    color: '#075985',
    fontWeight: '700',
  },
  busQrImage: {
    width: 160,
    height: 160,
    alignSelf: 'flex-start',
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  busActionButton: {
    marginTop: 4,
  },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  splitRow: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  switchBlock: {
    flex: 1,
    gap: 8,
  },
  switchRow: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  switchText: {
    color: '#0F172A',
    fontWeight: '700',
  },
  ticketMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  ticketMetaBox: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    minWidth: 140,
    gap: 4,
  },
  ticketMetaValue: {
    color: '#0F172A',
    fontWeight: '800',
    fontSize: 16,
  },
  ticketMetaValueSmall: {
    color: '#0F172A',
    fontWeight: '700',
  },
  ticketQrImage: {
    width: 220,
    height: 220,
    alignSelf: 'center',
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
  },
});
