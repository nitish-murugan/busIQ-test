import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Modal, NativeModules, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View, Vibration } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import SvgQRCode from 'react-native-qrcode-svg';
import * as Location from 'expo-location';

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

function resolveTrackingApiUrls() {
  const configuredBaseUrl = process.env.EXPO_PUBLIC_TRACKING_API_URL?.trim().replace(/\/$/, '');
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
  const hostUrl = host && host !== 'localhost' && host !== '127.0.0.1' ? `http://${host}:5000` : null;

  return [
    hostUrl,
    Platform.OS === 'android' ? 'http://10.0.2.2:5000' : null,
    'http://localhost:5000',
  ].filter(Boolean);
}

const API_BASE_URLS = resolveApiBaseUrls();
const TRACKING_API_BASE_URLS = resolveTrackingApiUrls();

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
  busType: 'Local',
  from: '',
  to: '',
  stops: [
    { name: '', lat: 0, lng: 0 },
    { name: '', lat: 0, lng: 0 },
  ],
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

function createOfflineTicketId() {
  return `offline-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function createOfflineOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function parseDateWithTime(travelDate, timeValue) {
  const base = String(timeValue || '').trim();
  const match = base.match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);

  if (!match) {
    const fallback = new Date(`${travelDate} ${base}`);
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

  const date = new Date(travelDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function normalizeBusFromQr(parsedBus, parsedId) {
  if (!parsedBus || typeof parsedBus !== 'object') {
    return null;
  }

  return {
    ...parsedBus,
    _id: parsedBus._id || parsedId,
    stops: Array.isArray(parsedBus.stops) ? parsedBus.stops : [],
    timings: Array.isArray(parsedBus.timings) ? parsedBus.timings : [],
  };
}

function buildOfflineTicketPayload({ bus, bookingForm }) {
  const [startTimeRaw, endTimeRaw] = String(bookingForm.timingLabel || '').split(' - ');
  const validFromDate = parseDateWithTime(bookingForm.travelDate, startTimeRaw || bus.startTime);
  const validToDate = parseDateWithTime(bookingForm.travelDate, endTimeRaw || bus.endTime);

  if (!validFromDate || !validToDate || Number.isNaN(validFromDate.getTime()) || Number.isNaN(validToDate.getTime())) {
    throw new Error('Unable to build ticket validity from selected timing');
  }

  return {
    type: 'offline-ticket',
    id: createOfflineTicketId(),
    offlineMode: true,
    issuedAt: new Date().toISOString(),
    travelDate: bookingForm.travelDate,
    busId: bus._id,
    busNumber: bus.busNumber,
    timingLabel: bookingForm.timingLabel,
    startStop: bookingForm.startStop,
    endStop: bookingForm.endStop,
    seats: Number(bookingForm.seats),
    otp: createOfflineOtp(),
    validFrom: validFromDate.toISOString(),
    validTo: validToDate.toISOString(),
  };
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

async function requestTrackingJson(path) {
  let lastNetworkError = null;
  const triedBaseUrls = [];

  for (const baseUrl of TRACKING_API_BASE_URLS) {
    try {
      triedBaseUrls.push(baseUrl);
      const response = await fetch(`${baseUrl}${path}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.message || 'Unable to load live tracking data');
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
  throw new Error(`Tracking service unreachable.${attempted} Start the Python tracker on port 5000 and make sure the app can reach it on your device or emulator.`.trim() || lastNetworkError?.message || 'Network request failed');
}

function formatCoordinate(value) {
  return typeof value === 'number' ? value.toFixed(6) : '';
}

function normalizeBusNumber(value) {
  return String(value || '').trim().toLowerCase();
}

function buildMapEmbedUrl(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  const latDelta = 0.0005;
  const lngDelta = 0.0005;
  const left = lng - lngDelta;
  const right = lng + lngDelta;
  const top = lat + latDelta;
  const bottom = lat - latDelta;

  return `https://www.openstreetmap.org/export/embed.html?bbox=${left}%2C${bottom}%2C${right}%2C${top}&layer=mapnik&marker=${lat}%2C${lng}`;
}

function AppHeader({ session, onLogout }) {
  return (
    <View style={styles.headerCard}>
      <View style={styles.headerLeft}>
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

  const handleBarcodeScanned = async ({ data }) => {
    if (locked) {
      return;
    }

    const parsed = parseQrData(data);
    if (!parsed) {
      Alert.alert('Invalid QR', 'This QR code is not recognized by the app.');
      return;
    }

    setLocked(true);
    try {
      // Wait for onMatch to finish (supports async verification), then continue
      await Promise.resolve(onMatch(parsed, data));
    } catch (e) {
      // If onMatch throws, show error (it may already show alerts)
      console.log('Scanner onMatch error:', e);
    } finally {
      // Small delay before unlocking to avoid duplicate rapid scans
      setTimeout(() => setLocked(false), 600);
    }
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.scannerModalBackdrop}>
        <View style={styles.scannerModalSheet}>
          <View style={styles.scannerModalHeader}>
            <View style={styles.scannerModalHeaderText}>
              <Text style={styles.kicker}>Scan mode</Text>
              <Text style={styles.scannerModalTitle}>{label}</Text>
              <Text style={styles.scannerModalDescription}>{description}</Text>
            </View>
            <Pressable onPress={onClose} style={styles.scannerCloseButton}>
              <Text style={styles.scannerCloseButtonText}>Close</Text>
            </Pressable>
          </View>

          {!permission ? (
            <View style={styles.scannerPermissionContent}>
              <Text style={styles.cardTitle}>Preparing camera</Text>
              <Text style={styles.cardSubtitle}>Please wait while the scanner initializes.</Text>
            </View>
          ) : !permission.granted ? (
            <View style={styles.scannerPermissionContent}>
              <Text style={styles.cardTitle}>Camera permission required</Text>
              <Text style={styles.cardSubtitle}>Grant camera access to scan QR codes.</Text>
              <PrimaryButton label="Grant Camera Permission" onPress={requestPermission} />
            </View>
          ) : (
            <>
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
            </>
          )}
        </View>
      </View>
    </Modal>
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
        {(bus.stops || []).map((stop, idx) => {
          const stopName = getStopName(stop);
          return (
            <View key={`stop-${idx}-${stopName}`} style={styles.stopChip}>
              <Text style={styles.stopChipText}>{stopName}</Text>
            </View>
          );
        })}
      </View>
      {bus.qrDataUrl ? <Image source={{ uri: bus.qrDataUrl }} style={styles.busQrImage} /> : null}
      {!hideActions && onStartBooking ? (
        <PrimaryButton label="Book this bus" onPress={onStartBooking} style={styles.busActionButton} />
      ) : null}
    </Card>
  );
}

function RouteAssistantLauncher({ session }) {
  const [open, setOpen] = useState(false);
  const [fromCity, setFromCity] = useState('');
  const [toCity, setToCity] = useState('');
  const [loading, setLoading] = useState(false);
  const [routeResult, setRouteResult] = useState(null);
  const [routeError, setRouteError] = useState('');

  useEffect(() => {
    if (open) {
      setRouteError('');
    }
  }, [open]);

  const analyzeRoute = async () => {
    const from = String(fromCity || '').trim();
    const to = String(toCity || '').trim();

    if (!from || !to) {
      setRouteError('Please enter both From city and To city.');
      setRouteResult(null);
      return;
    }

    try {
      setLoading(true);
      setRouteError('');
      const data = await requestJson('/routes/plan', {
        method: 'POST',
        token: session.token,
        body: {
          fromCity: from,
          toCity: to,
        },
      });

      setRouteResult(data.route || null);
    } catch (error) {
      setRouteResult(null);
      setRouteError(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Pressable style={styles.aiLauncherButton} onPress={() => setOpen(true)}>
        <Text style={styles.aiLauncherButtonText}>AI</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.aiModalBackdrop}>
          <KeyboardAvoidingView style={styles.aiModalShell} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.aiModalCard}>
              <View style={styles.aiModalHeader}>
                <View style={styles.aiModalHeaderText}>
                  <Text style={styles.kicker}>Route assistant</Text>
                  <Text style={styles.aiModalTitle}>Find the bus chain</Text>
                  <Text style={styles.aiModalSubtitle}>Enter the from and to cities. I’ll search the stored buses and transfer stops.</Text>
                </View>
                <Pressable onPress={() => setOpen(false)} style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>Close</Text>
                </Pressable>
              </View>

              <ScrollView contentContainerStyle={styles.aiModalContent} showsVerticalScrollIndicator={false}>
                <View style={styles.aiBubbleAssistant}>
                  <Text style={styles.aiBubbleText}>Tell me where you want to start and where you want to go. I will only return bus hops and transfer points.</Text>
                </View>

                <Field label="From city" value={fromCity} onChangeText={setFromCity} placeholder="City A" />
                <Field label="To city" value={toCity} onChangeText={setToCity} placeholder="City C" />

                <PrimaryButton label="Analyze route" onPress={analyzeRoute} loading={loading} />

                {routeError ? (
                  <View style={styles.aiBubbleUser}>
                    <Text style={styles.aiBubbleUserText}>{routeError}</Text>
                  </View>
                ) : null}

                {routeResult ? (
                  <>
                    <View style={styles.aiBubbleAssistant}>
                      <Text style={styles.aiBubbleText}>
                        {routeResult.found
                          ? routeResult.summary
                          : routeResult.message || 'No connected route found.'}
                      </Text>
                    </View>
                    {routeResult.found ? (
                      <View style={styles.aiRouteList}>
                        <View style={styles.aiRouteHeaderBox}>
                          <Text style={styles.aiRouteBusesLabel}>Buses required:</Text>
                          <Text style={styles.aiRouteAllBuses}>
                            {routeResult.segments.map((seg) => seg.busNumber).join(' → ')}
                          </Text>
                        </View>
                        <Text style={styles.aiRouteMeta}>{routeResult.transfers ? `${routeResult.transfers} transfer${routeResult.transfers === 1 ? '' : 's'}` : 'Direct route'}</Text>
                        {routeResult.segments.map((segment, index) => (
                          <View key={`${segment.busId}-${index}`} style={styles.aiRouteSegment}>
                            <Text style={styles.aiRouteSegmentTitle}>Bus {segment.busNumber}</Text>
                            <Text style={styles.aiRouteSegmentText}>{segment.routeStops.join(' → ')}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : null}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

function OfflineBookingFlow({ onClose, compact = false }) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [offlineBus, setOfflineBus] = useState(null);
  const [bookingForm, setBookingForm] = useState(bookingInitialState);
  const [generatedTicket, setGeneratedTicket] = useState(null);

  const handleOfflineBusScan = async (parsed) => {
    if (parsed?.type !== 'bus') {
      Alert.alert('Invalid QR', 'Please scan a bus QR code.');
      return;
    }

    const busFromQr = normalizeBusFromQr(parsed.bus, parsed.id);
    if (!busFromQr) {
      Alert.alert('Offline data missing', 'This bus QR does not include embedded route data. Re-generate this bus QR from the latest app version.');
      return;
    }

    setOfflineBus(busFromQr);
    setGeneratedTicket(null);
    setScannerOpen(false);
    setBookingForm((current) => ({
      ...current,
      timingLabel: busFromQr.timings?.[0]?.label || humanTimeRange(busFromQr.startTime, busFromQr.endTime),
      startStop: busFromQr.stops?.[0] || '',
      endStop: busFromQr.stops?.[busFromQr.stops.length - 1] || '',
      seats: '1',
    }));
  };

  const createOfflineBooking = () => {
    if (!offlineBus) {
      Alert.alert('Scan bus first', 'Scan a bus QR to load route details before booking offline.');
      return;
    }

    const travelDate = String(bookingForm.travelDate || '').trim();
    const timingLabel = String(bookingForm.timingLabel || '').trim();
    const startStop = String(bookingForm.startStop || '').trim();
    const endStop = String(bookingForm.endStop || '').trim();
    const seatsRequested = Number(bookingForm.seats);
    if (!travelDate || !timingLabel || !startStop || !endStop || !Number.isInteger(seatsRequested) || seatsRequested < 1) {
      Alert.alert('Missing details', 'Please fill all booking details before booking.');
      return;
    }

    if (!Number.isInteger(seatsRequested) || seatsRequested < 1 || seatsRequested > Number(offlineBus.seats || 0)) {
      Alert.alert('Invalid seats', `Seats must be between 1 and ${offlineBus.seats}.`);
      return;
    }

    const startIndex = (offlineBus.stops || []).indexOf(startStop);
    const endIndex = (offlineBus.stops || []).indexOf(endStop);
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      Alert.alert('Invalid route', 'Choose valid start and end stops in route order.');
      return;
    }

    try {
      const offlineTicket = buildOfflineTicketPayload({
        bus: offlineBus,
        bookingForm: { ...bookingForm, travelDate, timingLabel, startStop, endStop, seats: String(seatsRequested) },
      });
      setGeneratedTicket(offlineTicket);
    } catch (error) {
      Alert.alert('Ticket generation failed', error.message);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.scrollContent, compact && styles.offlineCompactContent]}>
      <Card>
        <SectionTitle
          title="Offline booking"
          description="Scan bus QR with embedded route data and generate an offline ticket."
        />
        <Text style={styles.helperText}>No network is needed after scanning a supported bus QR.</Text>
        <View style={styles.rowButtons}>
          <PrimaryButton label="Scan bus QR" onPress={() => setScannerOpen(true)} style={styles.flexButton} />
          {onClose ? (
            <Pressable style={styles.secondaryAction} onPress={onClose}>
              <Text style={styles.secondaryActionText}>Close</Text>
            </Pressable>
          ) : null}
        </View>
      </Card>

      {offlineBus ? (
        <>
          <BusDetailsCard bus={offlineBus} hideActions />
          <Card>
            <SectionTitle title="Book offline ticket" description="Select date, timing and stops. This ticket is generated locally." />
            <View style={styles.infoRow}>
              {(offlineBus.timings || [{ label: humanTimeRange(offlineBus.startTime, offlineBus.endTime) }]).map((timing) => (
                <PillButton
                  key={timing.label}
                  label={timing.label}
                  active={bookingForm.timingLabel === timing.label}
                  onPress={() => setBookingForm((current) => ({ ...current, timingLabel: timing.label }))}
                />
              ))}
            </View>
            <Field
              label="Travel date"
              value={bookingForm.travelDate}
              onChangeText={(travelDate) => setBookingForm((current) => ({ ...current, travelDate }))}
              placeholder="YYYY-MM-DD"
            />
            <Field
              label="Seats"
              value={bookingForm.seats}
              onChangeText={(seats) => setBookingForm((current) => ({ ...current, seats }))}
              keyboardType="number-pad"
              placeholder="1"
            />

            <Text style={styles.sectionMiniLabel}>Start stop</Text>
            <View style={styles.stopWrap}>
              {(offlineBus.stops || []).map((stop, idx) => {
                const stopName = getStopName(stop);
                return (
                  <PillButton
                    key={`offline-start-${idx}-${stopName}`}
                    label={stopName}
                    active={bookingForm.startStop === stopName}
                    onPress={() => setBookingForm((current) => ({ ...current, startStop: stopName }))}
                  />
                );
              })}
            </View>

            <Text style={styles.sectionMiniLabel}>End stop</Text>
            <View style={styles.stopWrap}>
              {(offlineBus.stops || []).map((stop, idx) => {
                const stopName = getStopName(stop);
                return (
                  <PillButton
                    key={`offline-end-${idx}-${stopName}`}
                    label={stopName}
                    active={bookingForm.endStop === stopName}
                    onPress={() => setBookingForm((current) => ({ ...current, endStop: stopName }))}
                  />
                );
              })}
            </View>

            <PrimaryButton label="Generate offline ticket" onPress={createOfflineBooking} />
          </Card>
        </>
      ) : null}

      {generatedTicket ? (
        <Card>
          <SectionTitle title="Offline ticket" description="Show this QR to admin for verification." />
          <View style={styles.ticketMetaGrid}>
            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Ticket</Text><Text style={styles.ticketMetaValueSmall}>#{generatedTicket.id.slice(-8)}</Text></View>
            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Bus</Text><Text style={styles.ticketMetaValue}>{generatedTicket.busNumber}</Text></View>
            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{generatedTicket.otp}</Text></View>
            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Status</Text><Text style={styles.ticketMetaValueSmall}>Offline</Text></View>
          </View>

          <View style={styles.localQrWrap}>
            <SvgQRCode value={JSON.stringify(generatedTicket)} size={220} />
          </View>

          <Text style={styles.helperText}>Route: {generatedTicket.startStop} to {generatedTicket.endStop} • Seats: {generatedTicket.seats}</Text>
          <Text style={styles.helperText}>Validity: {formatDateTime(generatedTicket.validFrom)} - {formatDateTime(generatedTicket.validTo)}</Text>
        </Card>
      ) : null}

      {scannerOpen ? (
        <ScannerPanel
          purpose="offline-bus"
          label="Scan bus QR"
          description="Scan a bus QR to load offline route details."
          onClose={() => setScannerOpen(false)}
          onMatch={handleOfflineBusScan}
        />
      ) : null}
    </ScrollView>
  );
}

function LiveTrackingPanel({ ticket, onClose }) {
  const [locationData, setLocationData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  const ticketBusNumber = normalizeBusNumber(ticket?.bus?.busNumber || ticket?.busNumber);
  const liveBusNumber = normalizeBusNumber(locationData?.busNumber);
  const busMatches = Boolean(ticketBusNumber && liveBusNumber && ticketBusNumber === liveBusNumber);
  const waitingForBusData = !liveBusNumber;

  useEffect(() => {
    let isActive = true;

    const loadLiveLocation = async () => {
      try {
        setError('');
        const data = await requestTrackingJson('/data');

        if (!isActive) {
          return;
        }

        const nextPoint = {
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          timeStamp: data.timeStamp,
          busNumber: data.busNumber,
        };

        setLocationData(nextPoint);
        setHistory((current) => [nextPoint, ...current].slice(0, 5));
      } catch (trackingError) {
        if (isActive) {
          setError(trackingError.message);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    setLoading(true);
    loadLiveLocation();
    const intervalId = setInterval(loadLiveLocation, 5000);

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [ticket?._id]);

  const mapUrl = useMemo(() => buildMapEmbedUrl(locationData?.latitude, locationData?.longitude), [locationData]);

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={styles.trackingModalScreen}>
        <View style={styles.trackingModalHeader}>
          <View>
            <Text style={styles.kicker}>Live tracking</Text>
            <Text style={styles.trackingTitle}>Bus {ticket?.bus?.busNumber || ticket?.busNumber || 'Ticket'}</Text>
            <Text style={styles.trackingSubtitle}>Updates every 5 seconds from the tracking endpoint.</Text>
          </View>
          <View style={styles.trackingHeaderActions}>
            <Pressable onPress={onClose} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText1}>Back</Text>
            </Pressable>
          </View>
        </View>

        <Card style={styles.trackingCard}>
          {busMatches ? (
            <>
              <View style={styles.trackingMapWrap}>
                {mapUrl ? (
                  <View style={styles.trackingIframeWrap}>
                    {Platform.OS === 'web' ? (
                      <iframe
                        title="Live bus location map"
                        src={mapUrl}
                        style={styles.trackingIframe}
                        loading="lazy"
                      />
                    ) : (
                      <View style={styles.trackingMapFallback}>
                        <Text style={styles.helperText}>Open this screen on the web build to see the embedded map.</Text>
                      </View>
                    )}
                    <View style={styles.trackingPinWrap}>
                      <View style={styles.trackingPinDot} />
                      <View style={styles.trackingPinStem} />
                    </View>
                  </View>
                ) : (
                  <View style={styles.trackingMapFallback}>
                    <Text style={styles.helperText}>Waiting for location data...</Text>
                  </View>
                )}
                <View style={styles.trackingMapOverlay}>
                  <Text style={styles.trackingOverlayLabel}>{locationData?.busNumber || ticket?.bus?.busNumber || 'Live bus'}</Text>
                  <Text style={styles.trackingOverlayValue}>{locationData?.timeStamp || 'Fetching live position...'}</Text>
                </View>
              </View>

              <View style={styles.ticketMetaGrid}>
                <View style={styles.ticketMetaBox}>
                  <Text style={styles.infoLabel}>Latitude</Text>
                  <Text style={styles.ticketMetaValue}>{formatCoordinate(locationData?.latitude)}</Text>
                </View>
                <View style={styles.ticketMetaBox}>
                  <Text style={styles.infoLabel}>Longitude</Text>
                  <Text style={styles.ticketMetaValue}>{formatCoordinate(locationData?.longitude)}</Text>
                </View>
                <View style={styles.ticketMetaBox}>
                  <Text style={styles.infoLabel}>Ticket</Text>
                  <Text style={styles.ticketMetaValueSmall}>#{ticket?._id?.slice(-8) || 'n/a'}</Text>
                </View>
                <View style={styles.ticketMetaBox}>
                  <Text style={styles.infoLabel}>Status</Text>
                  <Text style={styles.ticketMetaValueSmall}>{loading ? 'Loading' : error ? 'Offline' : 'Live'}</Text>
                </View>
              </View>

              {error ? <Text style={styles.trackingErrorText}>{error}</Text> : null}
            </>
          ) : (
            <View style={styles.trackingMismatchWrap}>
              <Text style={styles.trackingMismatchTitle}>{waitingForBusData ? 'Fetching live bus data...' : 'Bus number mismatch'}</Text>
              <Text style={styles.helperText}>Ticket bus: {ticket?.bus?.busNumber || ticket?.busNumber || 'n/a'}</Text>
              <Text style={styles.helperText}>Live data bus: {locationData?.busNumber || 'waiting for /data'}</Text>
              <Text style={styles.helperText}>Only matching bus numbers will show the live GPS view.</Text>
            </View>
          )}
        </Card>
      </View>
    </Modal>
  );
}

function AuthScreen({ onAuthed, onOpenOfflineBooking }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(authInitialState);
  const [loading, setLoading] = useState(false);
  const [selectedLoginChoice, setSelectedLoginChoice] = useState(null);

  const submit = async () => {
    try {
      if (mode === 'login' && !selectedLoginChoice) {
        Alert.alert('Select login type', 'Please select either User login or Admin login before continuing.');
        return;
      }

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
    <ScrollView contentContainerStyle={[styles.scrollContent, styles.authScrollContent]}>
      <View style={styles.authScreenLayout}>
        <View style={styles.authScreenTop}>
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

        </View>

        {mode === 'login' ? (
          <View style={styles.loginChoiceDock}>
            <Pressable onPress={() => setSelectedLoginChoice('user')} style={[styles.loginChoiceButton, selectedLoginChoice === 'user' && styles.loginChoiceButtonActive]}>
              <Text style={[styles.loginChoiceButtonText, selectedLoginChoice === 'user' && styles.loginChoiceButtonTextActive]}>User login</Text>
            </Pressable>
            <Pressable onPress={() => setSelectedLoginChoice('admin')} style={[styles.loginChoiceButton, selectedLoginChoice === 'admin' && styles.loginChoiceButtonActive]}>
              <Text style={[styles.loginChoiceButtonText, selectedLoginChoice === 'admin' && styles.loginChoiceButtonTextActive]}>Admin login</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable style={styles.offlineEntryButton} onPress={onOpenOfflineBooking}>
          <Text style={styles.offlineEntryButtonText}>Offline booking</Text>
        </Pressable>
      </View>

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
  const [trackingTicket, setTrackingTicket] = useState(null);
  const [category, setCategory] = useState(null);
  const [categoryBuses, setCategoryBuses] = useState([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryPageOpen, setCategoryPageOpen] = useState(false);
  const [refreshingTicket, setRefreshingTicket] = useState(false);
  const [offlineBookingOpen, setOfflineBookingOpen] = useState(false);

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

  const refreshSelectedTicket = async () => {
    if (!selectedTicketId) {
      // No selection; just reload all
      return loadMyBookings();
    }

    try {
      setRefreshingTicket(true);
      const data = await requestJson('/bookings/me', { token: session.token });
      const myTickets = data.bookings || [];
      setTickets(myTickets);
      // keep the same selectedTicketId (if exists)
      const exists = myTickets.some((t) => t._id === selectedTicketId);
      if (!exists) {
        setSelectedTicketId(myTickets[0]?._id || null);
      }
    } catch (error) {
      Alert.alert('Refresh failed', error.message);
    } finally {
      setRefreshingTicket(false);
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

  const loadBusesByType = async (type) => {
    try {
      setCategory(type);
      setCategoryLoading(true);
      const data = await requestJson(`/buses?type=${encodeURIComponent(type)}`, { token: session.token });
      setCategoryBuses(data.buses || []);
    } catch (error) {
      Alert.alert('Could not load buses', error.message);
    } finally {
      setCategoryLoading(false);
    }
  };

  const searchBusInCategory = async () => {
    if (!categorySearch.trim()) {
      return loadBusesByType(category || 'Local');
    }

    try {
      setCategoryLoading(true);
      const data = await requestJson(`/buses?number=${encodeURIComponent(categorySearch.trim())}`, { token: session.token });
      if (data.bus) {
        setCategoryBuses([data.bus]);
      } else {
        setCategoryBuses([]);
        Alert.alert('No bus found', 'No bus matched that number');
      }
    } catch (error) {
      Alert.alert('Search failed', error.message);
    } finally {
      setCategoryLoading(false);
    }
  };

  const openCategory = (type) => {
    setCategory(type);
    setCategorySearch('');
    setCategoryPageOpen(true);
    loadBusesByType(type);
  };

  const closeCategory = () => {
    setCategoryPageOpen(false);
    setCategoryBuses([]);
    setCategoryLoading(false);
    setCategorySearch('');
    // leave `category` so last opened remains known if needed
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
      if (!selectedBus) {
        Alert.alert('Missing details', 'Please search or scan a bus before booking.');
        return;
      }

      const travelDate = String(bookingForm.travelDate || '').trim();
      const timingLabel = String(bookingForm.timingLabel || '').trim();
      const startStop = String(bookingForm.startStop || '').trim();
      const endStop = String(bookingForm.endStop || '').trim();
      const seats = Number(bookingForm.seats);

      if (!travelDate || !timingLabel || !startStop || !endStop || !Number.isInteger(seats) || seats < 1) {
        Alert.alert('Missing details', 'Please fill all booking details before booking.');
        return;
      }

      setLoading(true);
      const data = await requestJson('/bookings', {
        method: 'POST',
        token: session.token,
        body: {
          busId: selectedBus._id,
          travelDate,
          timingLabel,
          startStop,
          endStop,
          seats,
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

  const openLiveTracking = (ticketItem) => {
    setSelectedTicketId(ticketItem._id);
    setTrackingTicket(ticketItem);
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <AppHeader session={session} onLogout={onLogout} />

      <View style={styles.tabRow}>
        <PillButton label="Search bus" active={activeTab === 'search'} onPress={() => setActiveTab('search')} />
        <PillButton label="Ticket" active={activeTab === 'ticket'} onPress={() => setActiveTab('ticket')} />
        <PillButton label="Offline booking" active={offlineBookingOpen} onPress={() => setOfflineBookingOpen(true)} />
      </View>

      {activeTab === 'search' ? (
        <>
          <Modal visible={categoryPageOpen} animationType="slide" onRequestClose={closeCategory}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <View style={{ padding: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Pressable onPress={closeCategory} style={styles.secondaryAction}>
                    <Text style={styles.secondaryActionText}>Back</Text>
                  </Pressable>
                  <SectionTitle title={`${category || ''} buses`} description={`Listing ${category || ''} buses`} />
                  <View style={{ width: 60 }} />
                </View>

                <View style={{ marginBottom: 12 }}>
                  <Field label="Search bus number" value={categorySearch} onChangeText={setCategorySearch} placeholder="BUS-101" />
                </View>

                <View style={[styles.rowButtons, styles.modalRowButtons]}>
                  <PrimaryButton label="Search" onPress={searchBusInCategory} loading={categoryLoading} style={styles.flexButton} />
                  <Pressable style={styles.secondaryAction} onPress={() => { setCategorySearch(''); loadBusesByType(category || 'Local'); }}>
                    <Text style={styles.secondaryActionText}>Clear</Text>
                  </Pressable>
                </View>

                {categoryLoading ? (
                  <Text style={[styles.helperText, { marginTop: 12 }]}>Please wait…</Text>
                ) : null}

                {categoryBuses.length ? (
                  <View style={styles.categoryListWrap}>
                    {categoryBuses.map((bus) => (
                      <View key={bus._id} style={[styles.ticketListItem, styles.busListItem, { marginBottom: 12 }]}> 
                        <View style={styles.busTopRow}>
                          <View>
                            <Text style={styles.cardTitle}>{bus.busNumber}</Text>
                            <Text style={styles.cardSubtitle}>{bus.from} → {bus.to}</Text>
                          </View>
                          <PrimaryButton label="Select" onPress={() => { setSelectedBus(bus); setCategoryPageOpen(false); }} style={styles.selectButton} />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : (!categoryLoading && <Text style={[styles.helperText, { marginTop: 12 }]}>No buses in this category.</Text>)}
              </View>
            </ScrollView>
          </Modal>

          <Card>
            <SectionTitle title="Find your route" description="Search by bus number or scan the bus QR to load its stops and schedule." />
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
        </>
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
            {(selectedBus.stops || []).map((stop, idx) => {
              const stopName = getStopName(stop);
              return (
                <PillButton key={`start-${idx}-${stopName}`} label={stopName} active={bookingForm.startStop === stopName} onPress={() => setBookingForm((current) => ({ ...current, startStop: stopName }))} />
              );
            })}
          </View>

          <Text style={styles.sectionMiniLabel}>End stop</Text>
          <View style={styles.stopWrap}>
            {(selectedBus.stops || []).map((stop, idx) => {
              const stopName = getStopName(stop);
              return (
                <PillButton key={`end-${idx}-${stopName}`} label={stopName} active={bookingForm.endStop === stopName} onPress={() => setBookingForm((current) => ({ ...current, endStop: stopName }))} />
              );
            })}
          </View>

          <PrimaryButton label={`Just Pay ${currencyText(Number(bookingForm.seats) * 249)}`} onPress={createBooking} loading={loading} />
        </Card>
      ) : null}

      {activeTab === 'ticket' ? (
        <Card>
          <SectionTitle title="Your tickets" description="All booked tickets are listed here. Select one to show QR and OTP." />
          {tickets.length ? (
            <>
              <View style={styles.ticketListWrap}>
                {tickets.map((ticketItem) => {
                  const isSelected = (selectedTicket?._id || '') === ticketItem._id;

                  return (
                    <View key={ticketItem._id} style={[styles.ticketListItem, isSelected && styles.ticketListItemActive]}>
                      <View style={styles.busTopRow}>
                        <View style={styles.ticketListHeader}>
                          <Text style={styles.cardTitle}>{ticketItem.bus?.busNumber || 'BUS'}</Text>
                          <Text style={styles.cardSubtitle}>{ticketItem.travelDate} • {ticketItem.startStop} to {ticketItem.endStop}</Text>
                        </View>
                        <Text style={styles.seatsBadge}>{ticketItem.status}</Text>
                      </View>
                      <View style={styles.rowButtons}>
                        <Pressable style={styles.secondaryAction} onPress={() => setSelectedTicketId(ticketItem._id)}>
                          <Text style={styles.secondaryActionText}>{isSelected ? 'Selected' : 'View ticket'}</Text>
                        </Pressable>
                        <Pressable style={styles.liveTrackingButton} onPress={() => openLiveTracking(ticketItem)}>
                          <Text style={styles.liveTrackingButtonText}>Live tracking</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
              {selectedTicket ? (
                <>
                  <View style={styles.ticketMetaGrid}>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Booking</Text><Text style={styles.ticketMetaValue}>#{selectedTicket._id.slice(-8)}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{selectedTicket.otp}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Status</Text><Text style={styles.ticketMetaValue}>{selectedTicket.status}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Validity</Text><Text style={styles.ticketMetaValueSmall}>{ticketValidity}</Text></View>
                  </View>
                  <PrimaryButton label="Refresh status" onPress={refreshSelectedTicket} loading={refreshingTicket} />
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

      {trackingTicket ? <LiveTrackingPanel ticket={trackingTicket} onClose={() => setTrackingTicket(null)} /> : null}

      {offlineBookingOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setOfflineBookingOpen(false)}>
          <View style={styles.trackingModalScreen}>
            <OfflineBookingFlow onClose={() => setOfflineBookingOpen(false)} compact />
          </View>
        </Modal>
      ) : null}
    </ScrollView>
  );
}

async function getStopLocation() {
  try {
    let { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission denied', 'Location permission is required to capture stop coordinates');
      return null;
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    return {
      lat: location.coords.latitude,
      lng: location.coords.longitude,
    };
  } catch (error) {
    Alert.alert('Location error', error.message);
    return null;
  }
}

function getStopName(stop) {
  if (typeof stop === 'string') {
    return stop;
  }
  if (typeof stop === 'object' && stop && stop.name) {
    return stop.name;
  }
  return '';
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
  const [otpVerify, setOtpVerify] = useState('');

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
    setForm((current) => ({ ...current, stops: [...current.stops, { name: '', lat: 0, lng: 0 }] }));
  };

  const updateStop = (index, updates) => {
    setForm((current) => {
      const nextStops = [...current.stops];
      if (typeof updates === 'string') {
        // Backward compatibility: if string is passed, update name
        nextStops[index] = { ...nextStops[index], name: updates };
      } else if (typeof updates === 'object') {
        // New format: merge updates
        nextStops[index] = { ...nextStops[index], ...updates };
      }
      return { ...current, stops: nextStops };
    });
  };

  const saveBus = async () => {
    try {
      setLoading(true);
      // Validate and filter stops: keep only stops with names, default coordinates to 0, 0 if not captured
      const stops = form.stops
        .filter((stop) => stop && stop.name && stop.name.trim())
        .map((stop) => ({
          name: stop.name.trim(),
          lat: typeof stop.lat === 'number' ? stop.lat : 0,
          lng: typeof stop.lng === 'number' ? stop.lng : 0,
        }));

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
          busType: form.busType,
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
      // Successful verification: vibrate once and continue scanning
      try {
        Vibration.vibrate(100);
      } catch (e) {
        console.log('Vibration failed', e);
      }

      // Do not show ticket details or close the scanner — continue scanning
      // Optionally store last verified ticket briefly (not exposing sensitive fields)
      // setVerifiedTicket(data.booking);
    } catch (error) {
      // If verification failed (already verified / outside window / not found), show alert
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
            <View key={`stop-${index}`} style={[styles.stopContainer, { marginBottom: 16 }]}>
              <Field 
                label={`Stop ${index + 1} name`} 
                value={stop.name || ''} 
                onChangeText={(value) => updateStop(index, { name: value })} 
                placeholder={`Stop ${index + 1}`} 
              />
              <View style={styles.stopLocationRow}>
                <Pressable 
                  style={styles.getLocationButton}
                  onPress={async () => {
                    const coords = await getStopLocation();
                    if (coords) {
                      updateStop(index, { lat: coords.lat, lng: coords.lng });
                      Alert.alert('Location captured', `Lat: ${coords.lat.toFixed(6)}, Lng: ${coords.lng.toFixed(6)}`);
                    }
                  }}
                >
                  <Text style={styles.getLocationButtonText}>Get location</Text>
                </Pressable>
                <View style={[styles.coordinateDisplay, stop.lat !== 0 || stop.lng !== 0 ? styles.coordinateDisplaySuccess : null]}>
                  <Text style={[styles.coordinateText, stop.lat !== 0 || stop.lng !== 0 ? styles.coordinateTextSuccess : null]}>
                    {stop.lat !== 0 || stop.lng !== 0 
                      ? `${stop.lat.toFixed(6)}, ${stop.lng.toFixed(6)}` 
                      : '0, 0'}
                  </Text>
                </View>
              </View>
            </View>
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
          <View style={{ gap: 12 }}>
            <Field label="OTP" value={otpVerify} onChangeText={(v) => setOtpVerify(v)} placeholder="Enter 6-digit OTP" keyboardType="number-pad" />
            <PrimaryButton label="Verify by OTP" onPress={async () => {
              try {
                setLoading(true);
                const data = await requestJson('/bookings/verify', {
                  method: 'POST',
                  token: session.token,
                  body: { otp: otpVerify },
                });

                setVerifiedTicket(data.booking);
                setScannerOpen(false);
                setActiveTab('verify');
                Alert.alert('Verified', 'Ticket verified successfully');
              } catch (error) {
                Alert.alert('Verification failed', error.message);
              } finally {
                setLoading(false);
              }
            }} />

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
          </View>
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
  const [offlineBookingOpen, setOfflineBookingOpen] = useState(false);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />
      <View style={styles.bgBlobOne} />
      <View style={styles.bgBlobTwo} />
      <View style={styles.appShell}>
        <ScrollView contentContainerStyle={styles.screenContent}>
          {!session ? (
            offlineBookingOpen ? (
              <>
                <AppHeader />
                <OfflineBookingFlow onClose={() => setOfflineBookingOpen(false)} />
              </>
            ) : (
              <>
                <AppHeader />
                <AuthScreen onAuthed={setSession} onOpenOfflineBooking={() => setOfflineBookingOpen(true)} />
              </>
            )
          ) : session.user.role === 'admin' ? (
            <AdminDashboard session={session} onLogout={() => setSession(null)} />
          ) : (
            <UserDashboard session={session} onLogout={() => setSession(null)} />
          )}
        </ScrollView>
        {session ? <RouteAssistantLauncher session={session} /> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#07111F',
  },
  appShell: {
    flex: 1,
    position: 'relative',
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
  authScrollContent: {
    flexGrow: 1,
  },
  authScreenLayout: {
    flex: 1,
    justifyContent: 'space-between',
    gap: 16,
  },
  authScreenTop: {
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
  loginChoiceDock: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 'auto',
    marginBottom: 0,
  },
  loginChoiceButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginChoiceButtonActive: {
    backgroundColor: '#E2E8F0',
    borderColor: '#94A3B8',
  },
  loginChoiceButtonText: {
    color: '#0F172A',
    fontWeight: '800',
  },
  loginChoiceButtonTextActive: {
    color: '#F8FAFC',
  },
  offlineEntryButton: {
    borderWidth: 1,
    borderColor: 'rgba(125, 211, 252, 0.42)',
    backgroundColor: '#081427',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offlineEntryButtonText: {
    color: '#BAE6FD',
    fontWeight: '800',
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
  scannerModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3, 7, 18, 0.82)',
    justifyContent: 'center',
    padding: 16,
  },
  scannerModalSheet: {
    backgroundColor: '#F8FAFC',
    borderRadius: 28,
    padding: 18,
    gap: 14,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.18)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 28,
    elevation: 10,
  },
  scannerModalHeader: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  scannerModalHeaderText: {
    flex: 1,
    gap: 4,
  },
  scannerModalTitle: {
    color: '#0F172A',
    fontSize: 24,
    fontWeight: '800',
  },
  scannerModalDescription: {
    color: '#64748B',
    lineHeight: 20,
  },
  scannerCloseButton: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 16,
  },
  scannerCloseButtonText: {
    color: '#F8FAFC',
    fontWeight: '800',
  },
  scannerPermissionContent: {
    gap: 12,
    paddingVertical: 20,
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
  modalRowButtons: {
    marginTop: 8,
  },
  categoryListWrap: {
    marginTop: 12,
  },
  selectButton: {
    paddingHorizontal: 22,
    minWidth: 110,
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
  secondaryButtonText1: {
    color: '#0F172A',
    fontWeight: '700',
  },
  secondaryButtonText1: {
    color: '#ffffff',
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
  aiLauncherButton: {
    position: 'absolute',
    right: 18,
    bottom: 18,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#22C55E',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
    elevation: 8,
    zIndex: 50,
  },
  aiLauncherButtonText: {
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: 1,
    fontSize: 16,
  },
  aiModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 17, 31, 0.72)',
    justifyContent: 'flex-end',
  },
  aiModalShell: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  aiModalCard: {
    backgroundColor: '#F8FAFC',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 24,
    maxHeight: '88%',
    gap: 16,
  },
  aiModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  aiModalHeaderText: {
    flex: 1,
    gap: 6,
  },
  aiModalTitle: {
    color: '#0F172A',
    fontSize: 24,
    fontWeight: '900',
  },
  aiModalSubtitle: {
    color: '#475569',
    lineHeight: 20,
  },
  aiModalContent: {
    gap: 14,
    paddingBottom: 8,
  },
  aiBubbleAssistant: {
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 20,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  aiBubbleText: {
    color: '#0F172A',
    lineHeight: 20,
    fontWeight: '600',
  },
  aiBubbleUser: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 20,
    alignSelf: 'flex-end',
    maxWidth: '100%',
  },
  aiBubbleUserText: {
    color: '#F8FAFC',
    lineHeight: 20,
    fontWeight: '700',
  },
  aiRouteList: {
    gap: 10,
    marginTop: 6,
  },
  aiRouteHeaderBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 12,
    borderWidth: 2,
    borderColor: '#22C55E',
    gap: 6,
  },
  aiRouteBusesLabel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  aiRouteAllBuses: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  aiRouteMeta: {
    color: '#0F172A',
    fontWeight: '800',
  },
  aiRouteSegment: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    gap: 4,
  },
  aiRouteSegmentTitle: {
    color: '#0F172A',
    fontWeight: '900',
  },
  aiRouteSegmentText: {
    color: '#475569',
    lineHeight: 18,
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
  localQrWrap: {
    alignSelf: 'center',
    padding: 12,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
  },
  offlineCompactContent: {
    paddingBottom: 24,
  },
  ticketListWrap: {
    gap: 12,
    marginBottom: 12,
  },
  ticketListItem: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 20,
    padding: 14,
    backgroundColor: '#F8FAFC',
    gap: 12,
  },
  ticketListItemActive: {
    borderColor: '#7DD3FC',
    backgroundColor: '#ECFEFF',
  },
  ticketListHeader: {
    flex: 1,
    gap: 4,
  },
  liveTrackingButton: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
  },
  liveTrackingButtonText: {
    color: '#F8FAFC',
    fontWeight: '800',
  },
  trackingModalScreen: {
    flex: 1,
    backgroundColor: '#07111F',
    padding: 16,
    gap: 16,
  },
  trackingModalHeader: {
    backgroundColor: '#081427',
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
    gap: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  trackingHeaderActions: {
    alignItems: 'flex-end',
  },
  trackingTitle: {
    color: '#F8FAFC',
    fontSize: 26,
    fontWeight: '800',
    marginTop: 4,
  },
  trackingSubtitle: {
    color: '#CBD5E1',
    marginTop: 6,
    lineHeight: 20,
  },
  trackingCard: {
    gap: 14,
  },
  trackingMapWrap: {
    position: 'relative',
    borderRadius: 22,
    overflow: 'hidden',
    minHeight: 280,
    backgroundColor: '#0F172A',
  },
  trackingIframeWrap: {
    width: '100%',
    height: 280,
    position: 'relative',
  },
  trackingIframe: {
    width: '100%',
    height: 280,
    border: 0,
    display: 'block',
    backgroundColor: '#E5E7EB',
  },
  trackingPinWrap: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -14 }, { translateY: -28 }],
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackingPinDot: {
    width: 18,
    height: 18,
    borderRadius: 18,
    backgroundColor: '#EF4444',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  trackingPinStem: {
    width: 3,
    height: 18,
    backgroundColor: '#EF4444',
    marginTop: -1,
  },
  trackingMapFallback: {
    height: 280,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  trackingMapOverlay: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
    backgroundColor: 'rgba(8, 20, 39, 0.82)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  trackingOverlayLabel: {
    color: '#7DD3FC',
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: '800',
  },
  trackingOverlayValue: {
    color: '#F8FAFC',
    fontWeight: '700',
  },
  trackingErrorText: {
    color: '#B91C1C',
    fontWeight: '700',
  },
  trackingHistoryWrap: {
    gap: 10,
  },
  trackingHistoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  trackingHistoryText: {
    color: '#0F172A',
    fontSize: 12,
    fontWeight: '600',
  },
  trackingMismatchWrap: {
    gap: 8,
    paddingVertical: 12,
  },
  trackingMismatchTitle: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '800',
  },
  stopContainer: {
    gap: 8,
  },
  stopLocationRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  getLocationButton: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
  },
  getLocationButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  coordinateDisplay: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  coordinateDisplaySuccess: {
    backgroundColor: '#DCFCE7',
    borderColor: '#22C55E',
  },
  coordinateText: {
    color: '#64748B',
    fontWeight: '600',
    fontSize: 12,
  },
  coordinateTextSuccess: {
    color: '#166534',
    fontWeight: '700',
  },
});
