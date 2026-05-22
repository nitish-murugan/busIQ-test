import { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Animated, Image, KeyboardAvoidingView, Modal, NativeModules, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View, Vibration, ActivityIndicator, RefreshControl } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import SvgQRCode from 'react-native-qrcode-svg';
import * as Location from 'expo-location';

// npx eas-cli@latest build -p android --profile preview

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

function resolveApiBaseUrls() {
  const configuredBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim().replace(/\/$/, '');
  if (configuredBaseUrl) {
    return [configuredBaseUrl];
  }

  // Use Render backend as primary
  const renderBackendUrl = 'https://busbooking-backend-iqts.onrender.com/api';

  // Force the app to use the Render backend only to avoid accidental localhost/expo host fallbacks
  return [renderBackendUrl];
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
  busType: 'Local',
  from: '',
  to: '',
  stops: [
    { name: '', lat: 0, lng: 0 },
    { name: '', lat: 0, lng: 0 },
  ],
  conductorId: '',
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

const IST_OFFSET_MINUTES = 330;

function parseDateTimeInIST(travelDate, timeValue) {
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

  const [year, month, day] = String(travelDate).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }

  const utcMillis = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - (IST_OFFSET_MINUTES * 60 * 1000);
  return new Date(utcMillis);
}

function parseDateWithTime(travelDate, timeValue) {
  return parseDateTimeInIST(travelDate, timeValue);
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

function buildOfflineTicketPayload({ bus, bookingForm, userName }) {
  const timeParts = String(bookingForm.timingLabel || '').split(/\s+(?:-|to)\s+/i);
  const startTimeRaw = timeParts[0];
  const endTimeRaw = timeParts[1];
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
    userName: userName || '',
    travelDate: bookingForm.travelDate,
    busId: bus._id,
    busNumber: bus.busNumber,
    bus: {
      _id: bus._id,
      busNumber: bus.busNumber,
      startTime: bus.startTime,
      endTime: bus.endTime,
      stops: Array.isArray(bus.stops) ? bus.stops : [],
    },
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

      const responseText = await response.text();
      let data = {};

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          data = { message: responseText };
        }
      }

      if (!response.ok) {
        const backendMessage = String(data?.message || '').trim();
        const statusMessage = `Request failed with status ${response.status}`;
        const attemptedUrl = `${baseUrl}${path}`;
        throw new Error(backendMessage ? `${backendMessage} (${statusMessage}) - ${attemptedUrl}` : `${statusMessage} - ${attemptedUrl}`);
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

async function fetchTrackingLocation(trackingUrl) {
  const url = normalizeRemoteUrl(trackingUrl);

  if (!url) {
    throw new Error('Tracking URL is not configured');
  }

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.message || 'Unable to load live tracking data');
  }

  return data;
}

function formatCoordinate(value) {
  return typeof value === 'number' ? value.toFixed(6) : '';
}

function normalizeBusNumber(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRouteStop(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function routeStopIndex(routeStops, selectedStop) {
  const normalizedStop = normalizeRouteStop(selectedStop);
  return routeStops.findIndex((stop) => normalizeRouteStop(stop) === normalizedStop);
}

// Offline ticket management
const OFFLINE_TICKETS_KEY = 'offlineTickets';
const PENDING_SYNCS_KEY = 'pendingSyncs';

async function checkInternetConnectivity() {
  try {
    if (Platform.OS === 'web') {
      return typeof navigator === 'undefined' ? true : navigator.onLine;
    }

    const response = await fetch('https://www.google.com/favicon.ico', { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    return Platform.OS === 'web' ? true : false;
  }
}

async function saveOfflineTicket(ticket, userId) {
  try {
    const key = `${OFFLINE_TICKETS_KEY}_${userId}`;
    const stored = await AsyncStorage.getItem(key);
    const tickets = stored ? JSON.parse(stored) : [];
    const newTicket = {
      ...ticket,
      isOffline: true,
      savedAt: new Date().toISOString(),
      synced: false,
    };
    tickets.unshift(newTicket);
    await AsyncStorage.setItem(key, JSON.stringify(tickets));
    return newTicket;
  } catch (error) {
    console.error('Failed to save offline ticket:', error);
    throw error;
  }
}

async function loadOfflineTickets(userId) {
  try {
    const key = `${OFFLINE_TICKETS_KEY}_${userId}`;
    const stored = await AsyncStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to load offline tickets:', error);
    return [];
  }
}

async function syncOfflineTickets(userId, token) {
  try {
    const offlineTickets = await loadOfflineTickets(userId);
    const unsynced = offlineTickets.filter((t) => !t.synced);

    if (!unsynced.length) {
      return { success: true, synced: 0 };
    }

    let syncedCount = 0;
    const successfullyFinalIds = [];

    for (const ticket of unsynced) {
      try {
        // Send to server - adjust endpoint as needed
        const response = await requestJson('/bookings/sync-offline', {
          method: 'POST',
          token,
          body: ticket,
        });
        syncedCount += 1;
        // Track the original offline ticket for removal
        successfullyFinalIds.push(ticket.id || ticket.savedAt);
      } catch (error) {
        console.log('Failed to sync ticket:', ticket._id, error);
      }
    }

    // Remove successfully synced tickets from local storage
    const key = `${OFFLINE_TICKETS_KEY}_${userId}`;
    const updated = offlineTickets.filter(
      (t) => !successfullyFinalIds.includes(t.id || t.savedAt)
    );
    await AsyncStorage.setItem(key, JSON.stringify(updated));

    return { success: true, synced: syncedCount };
  } catch (error) {
    console.error('Sync failed:', error);
    return { success: false, synced: 0 };
  }
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

function AppHeader({ session, onLogout, menuActions = [], onBusQrScanned = null }) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const drawerTranslateX = useRef(new Animated.Value(-320)).current;

  useEffect(() => {
    Animated.timing(drawerTranslateX, {
      toValue: menuOpen ? 0 : -320,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [drawerTranslateX, menuOpen]);

  const handleAuthScanMatch = async (parsed) => {
    if (!parsed) {
      Alert.alert('Invalid QR', 'Not recognized');
      return;
    }

    if (parsed.type === 'bus') {
      if (onBusQrScanned) {
        await Promise.resolve(onBusQrScanned(parsed));
      } else {
        Alert.alert('Bus QR scanned', `Bus: ${parsed.bus?.busNumber || parsed.id}`);
      }
    } else if (parsed.type === 'ticket') {
      Alert.alert('Ticket QR scanned', `Ticket id: ${parsed.id}`);
    } else {
      Alert.alert('QR scanned', JSON.stringify(parsed));
    }
    setScannerOpen(false);
  };

  const handleTicketScan = async ({ id }, rawValue) => {
    try {
      console.log('handleTicketScan match:', { id, rawValue });
      setLoading(true);
      const data = await requestJson('/bookings/verify', {
        method: 'POST',
        token: session.token,
        body: { qrToken: rawValue || `ticket:${id}`, clientTime: new Date().toISOString() },
      });
      // Successful verification: vibrate once and continue scanning
      try {
        Vibration.vibrate(100);
      } catch (e) {
        console.log('Vibration failed', e);
      }

      const booking = data?.booking;
      const passengerName = booking?.user?.name || booking?.offlinePayload?.userName || 'N/A';
      const fromStop = booking?.startStop || 'N/A';
      const toStop = booking?.endStop || 'N/A';

      Alert.alert(
        'Ticket vierified successfully',
        `User Name: ${passengerName}\nFrom: ${fromStop}\nTo: ${toStop}`
      );
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
    <View style={styles.headerCard}>
      <View style={styles.headerTopRow}>
        {session ? (
          <Pressable style={styles.headerMenuButton} onPress={() => setMenuOpen(true)}>
            <View style={styles.hamburgerLine} />
            <View style={styles.hamburgerLine} />
            <View style={styles.hamburgerLine} />
          </Pressable>
        ) : (
          <View style={styles.headerBrand}>
            <Image source={require('./assets/appLogo.png')} style={styles.headerBrandLogo} />
            <View>
              <Text style={styles.headerBrandTitle}>BusIQ</Text>
              <Text style={styles.headerBrandSubtitle}>Smart booking and tracking</Text>
            </View>
          </View>
        )}
        <View style={styles.headerRight}>
          {session ? (
            <>
              {(session.user.role === 'user') ? (
                <Pressable style={styles.ghostIcon} onPress={() => setScannerOpen(true)}>
                  <Image source={require('./assets/qr-code-scan.png')} style={styles.ghostIconImage} />
                </Pressable>
              ) : (session.user.role === 'conductor') ? 
              (
                <Pressable style={styles.ghostIcon} onPress={() => setScannerOpen(true)}>
                  <Image source={require('./assets/qr-code-scan.png')} style={styles.ghostIconImage} />
                </Pressable>
              ) 
              : null}
              <Pressable style={styles.ghostButton} onPress={onLogout}>
                <Text style={styles.ghostButtonText}>Logout</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <View style={styles.drawerBackdrop}>
          <Pressable style={styles.drawerScrim} onPress={() => setMenuOpen(false)} />
          <Animated.View style={[styles.leftDrawer, { transform: [{ translateX: drawerTranslateX }] }]}>
            <View style={styles.drawerHandle} />
            <View style={styles.drawerSection}>
              {session ? (
                <>
                  {menuActions.map((action) => (
                    <Pressable
                      key={action.label}
                      style={styles.drawerItem}
                      onPress={() => {
                        setMenuOpen(false);
                        action.onPress?.();
                      }}
                    >
                      <Text style={styles.drawerItemText}>{action.label}</Text>
                    </Pressable>
                  ))}
                  <Pressable style={styles.drawerItem} onPress={() => { setMenuOpen(false); setScannerOpen(true); }}>
                    <Text style={styles.drawerItemText}>Scan QR</Text>
                  </Pressable>
                  <Pressable style={styles.drawerItem} onPress={() => { setMenuOpen(false); onLogout(); }}>
                    <Text style={styles.drawerItemText}>Logout</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={styles.drawerItem} onPress={() => setMenuOpen(false)}>
                  <Text style={styles.drawerItemText}>Close</Text>
                </Pressable>
              )}
            </View>
          </Animated.View>
        </View>
      </Modal>

      {scannerOpen ? (
        <ScannerPanel
          purpose={session.user.role === 'conductor' ? 'ticket' : 'bus'}
          label={session.user.role === 'conductor' ? 'Scan ticket QR' : 'Scan QR'}
          description={session.user.role === 'conductor' ? 'Scan a ticket QR to verify a passenger booking.' : 'Scan a bus or ticket QR.'}
          onClose={() => setScannerOpen(false)}
          onMatch={session.user.role === 'conductor' ? handleTicketScan : handleAuthScanMatch}
        />
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

  const crowd = getBusCrowdPresentation(bus);

  return (
    <Card>
      <View style={styles.busTopRow}>
        <View>
          <Text style={styles.cardTitle}>Bus {bus.busNumber}</Text>
          <Text style={styles.cardSubtitle}>{bus.from} to {bus.to}</Text>
        </View>
        <View style={styles.crowdStatusBadge}>
          <View style={[styles.crowdStatusDot, { backgroundColor: crowd.color }]} />
          <Text style={styles.crowdStatusText}>{crowd.label}</Text>
        </View>
      </View>
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

    const routeStops = getBusRouteStops(offlineBus);
    const startIndex = routeStopIndex(routeStops, startStop);
    const endIndex = routeStopIndex(routeStops, endStop);
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      Alert.alert('Invalid route', 'Choose valid start and end stops in route order.');
      return;
    }

    try {
      const offlineTicket = buildOfflineTicketPayload({
        bus: offlineBus,
        bookingForm: { ...bookingForm, travelDate, timingLabel, startStop, endStop, seats: String(seatsRequested) },
        userName: '',
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
            {(() => {
              const now = new Date();
              const validFrom = new Date(generatedTicket.validFrom);
              const validTo = new Date(generatedTicket.validTo);
              const isOfflineOtpVisible = now >= validFrom && now <= validTo;
              return isOfflineOtpVisible ? (
                <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{generatedTicket.otp}</Text></View>
              ) : (
                <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValueSmall}>Hidden (outside validity)</Text></View>
              );
            })()}
            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Status</Text><Text style={styles.ticketMetaValueSmall}>Offline</Text></View>
          </View>

          <View style={styles.localQrWrap}>
            <SvgQRCode value={JSON.stringify(generatedTicket)} size={220} />
          </View>

          <Text style={styles.helperText}>Route: {generatedTicket.startStop} to {generatedTicket.endStop} • Seats: {generatedTicket.seats}</Text>
          <Text style={styles.helperText}>Validity: {generatedTicket.travelDate} {generatedTicket.timingLabel}</Text>
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

function LiveTrackingPanel({ ticket, onClose, trackingUrl }) {
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
        const data = await fetchTrackingLocation(trackingUrl);

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
  }, [ticket?._id, trackingUrl]);

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

function AuthScreen({ onAuthed }) {
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
                  <PillButton label="Conductor" active={form.role === 'conductor'} onPress={() => setForm((current) => ({ ...current, role: 'conductor' }))} />
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
      </View>

    </ScrollView>
  );
}

function UserDashboard({ session, onLogout, refreshSignal, trackingUrl }) {
  const [activeTab, setActiveTab] = useState('search');
  const [searchValue, setSearchValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [previewBus, setPreviewBus] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [bookingForm, setBookingForm] = useState(bookingInitialState);
  const [stopPickerOpen, setStopPickerOpen] = useState(false);
  const [stopPickerType, setStopPickerType] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [showOnlyCurrentBooked, setShowOnlyCurrentBooked] = useState(false);

  const displayedTickets = useMemo(() => {
    if (showOnlyCurrentBooked && selectedTicketId) {
      return tickets.filter((t) => t._id === selectedTicketId);
    }
    return tickets;
  }, [tickets, showOnlyCurrentBooked, selectedTicketId]);
  const [trackingTicket, setTrackingTicket] = useState(null);
  const [category, setCategory] = useState(null);
  const [categoryBuses, setCategoryBuses] = useState([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryPageOpen, setCategoryPageOpen] = useState(false);
  const [refreshingTicket, setRefreshingTicket] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [allBuses, setAllBuses] = useState([]);
  const [routeInventory, setRouteInventory] = useState([]);
  const [fromSelection, setFromSelection] = useState('');
  const [toSelection, setToSelection] = useState('');
  const [locationPickerMode, setLocationPickerMode] = useState(null);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [locationPickerSearch, setLocationPickerSearch] = useState('');
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [scanBookingBusId, setScanBookingBusId] = useState(null);

  const loadMyBookings = async () => {
    try {
      const isOnline = await checkInternetConnectivity();

      if (isOnline) {
        const offlineTickets = await loadOfflineTickets(session.user._id);
        const unsynced = offlineTickets.filter((ticket) => !ticket.synced);

        if (unsynced.length) {
          await syncOfflineTickets(session.user._id, session.token);
        }
      }

      const data = await requestJson('/bookings/me', {
        token: session.token,
      });

      const myTickets = data?.bookings || [];

      if (isOnline) {
        setTickets(myTickets);
        setSelectedTicketId((current) => current || myTickets[0]?._id || null);
        return;
      }

      const offlineTickets = await loadOfflineTickets(session.user._id);
      setTickets(offlineTickets);
      setSelectedTicketId((current) => current || offlineTickets[0]?._id || null);
    } catch (error) {
      Alert.alert('Could not load tickets', error.message);
    }
  };

  const manualSyncTickets = async () => {
    try {
      setRefreshingTicket(true);
      const result = await syncOfflineTickets(session.user._id, session.token);
      await loadMyBookings();
      setActiveTab('ticket');
      setShowOnlyCurrentBooked(false);
      Alert.alert('Sync complete', result.synced > 0 ? `${result.synced} ticket(s) synced.` : 'No offline tickets needed syncing.');
    } catch (error) {
      Alert.alert('Sync failed', error.message);
    } finally {
      setRefreshingTicket(false);
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
  }, [session.token, refreshSignal]);

  useEffect(() => {
    let active = true;
    const loadLocations = async () => {
      try {
        setLoadingLocations(true);
        const isOnline = await checkInternetConnectivity();
        if (!isOnline) {
          return;
        }

        const data = await requestJson('/routes/inventory', { token: session.token });
        if (!active) return;
        setRouteInventory(data.buses || []);
      } catch (error) {
        console.log('Failed to load locations', error);
      } finally {
        if (active) setLoadingLocations(false);
      }
    };

    loadLocations();
    return () => { active = false; };
  }, [session.token, refreshSignal]);

  useEffect(() => {
    let active = true;
    const attemptSync = async () => {
      try {
        const isOnline = await checkInternetConnectivity();
        if (!isOnline) return;

        const offlineTickets = await loadOfflineTickets(session.user._id);
        const unsynced = offlineTickets.filter((t) => !t.synced);

        if (!unsynced.length) return;

        console.log('Attempting to sync', unsynced.length, 'offline tickets');
        const result = await syncOfflineTickets(session.user._id, session.token);

        if (active && result.synced > 0) {
          console.log('Synced', result.synced, 'tickets');
          // Reload bookings to reflect synced tickets
          await loadMyBookings();
        }
      } catch (error) {
        console.log('Sync attempt failed:', error);
      }
    };

    // Try sync immediately and then every 30 seconds
    attemptSync();
    const interval = setInterval(attemptSync, 30000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [session.user._id, session.token]);

  useEffect(() => {
    setActiveTab('search');
    setSearchValue('');
    setSelectedBus(null);
    setPreviewBus(null);
    setScannerOpen(false);
    setBookingForm(bookingInitialState);
    setStopPickerOpen(false);
    setStopPickerType(null);
    setSelectedTicketId(null);
    setTrackingTicket(null);
    setCategory(null);
    setCategoryBuses([]);
    setCategorySearch('');
    setCategoryLoading(false);
    setCategoryPageOpen(false);
    setSearchResults([]);
    setFromSelection('');
    setToSelection('');
    setLocationPickerMode(null);
    setLocationPickerOpen(false);
    setLocationPickerSearch('');
    setScanBookingBusId(null);
    setShowOnlyCurrentBooked(false);
  }, [refreshSignal]);

  const fetchBus = async (busNumber) => {
    const query = String(busNumber || '').trim();

    if (!query && !fromSelection && !toSelection) {
      Alert.alert('Search bus', 'Enter a bus number or select From/To.');
      return;
    }

    try {
      setLoading(true);

      // If bus number provided, use backend lookup
      if (query) {
        const data = await requestJson(`/buses?number=${encodeURIComponent(query)}`, { token: session.token });
        if (!data.bus) {
          setSearchResults([]);
          Alert.alert('No bus available', 'No bus is available for that number.');
        } else {
          setSearchResults([data.bus]);
          setSelectedBus(null);
          setPreviewBus(null);
        }
        return;
      }

      // Otherwise, filter client-side using cached allBuses if available
      const source = allBuses.length ? allBuses : (await requestJson('/buses', { token: session.token })).buses || [];

      const matches = (source || []).filter((b) => {
        const fromMatch = !fromSelection || (String(b.from || '') === fromSelection) || (Array.isArray(b.stops) && b.stops.some((s) => getStopName(s) === fromSelection));
        const toMatch = !toSelection || (String(b.to || '') === toSelection) || (Array.isArray(b.stops) && b.stops.some((s) => getStopName(s) === toSelection));
        return fromMatch && toMatch;
      });

      if (!matches.length) {
        setSearchResults([]);
        setSelectedBus(null);
        Alert.alert('No bus available', 'No bus is available for the selected route.');
      } else {
        setSearchResults(matches);
        setSelectedBus(null);
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

  const openBusBooking = (bus) => {
    if (!bus) {
      return;
    }

    const routeStops = getBusRouteStops(bus);
    const startStop = String(fromSelection || routeStops[0] || '').trim();
    const endStop = String(toSelection || routeStops[routeStops.length - 1] || '').trim();

    setSelectedBus(bus);
    setScanBookingBusId(null);
    setSearchResults([]);
    setPreviewBus(null);
    setBookingForm((current) => ({
      ...current,
      timingLabel: bus.timings?.[0]?.label || humanTimeRange(bus.startTime, bus.endTime),
      startStop,
      endStop,
    }));
    setActiveTab('ticket');
    setShowOnlyCurrentBooked(false);
  };

  const closeCategory = () => {
    setCategoryPageOpen(false);
    setCategoryBuses([]);
    setCategoryLoading(false);
    setCategorySearch('');
    // leave `category` so last opened remains known if needed
  };

  const openLocationPicker = (mode) => {
    setLocationPickerMode(mode);
    setLocationPickerSearch('');
    setLocationPickerOpen(true);
  };

  const closeLocationPicker = () => {
    setLocationPickerOpen(false);
    setLocationPickerMode(null);
    setLocationPickerSearch('');
  };

  const selectLocation = (city) => {
    if (locationPickerMode === 'to') {
      setToSelection(city);
    } else {
      setFromSelection(city);
    }

    closeLocationPicker();
  };

  const locationPickerItems = useMemo(() => {
    const query = locationPickerSearch.trim().toLowerCase();
    const itemSet = new Set();

    (routeInventory || []).forEach((bus) => {
      const citySource = locationPickerMode === 'to' ? bus.to : bus.from;
      const city = String(citySource || '').trim();
      const stopNames = (bus.stops || []).map((stop) => getStopName(stop)).filter(Boolean);
      const candidates = [city, ...stopNames].filter(Boolean);

      candidates.forEach((name) => {
        const normalized = String(name || '').trim();
        if (!normalized) {
          return;
        }

        if (query && !normalized.toLowerCase().includes(query)) {
          return;
        }

        itemSet.add(normalized);
      });
    });

    return Array.from(itemSet).sort((left, right) => left.localeCompare(right));
  }, [routeInventory, locationPickerMode, locationPickerSearch]);

  const availableRouteStats = useMemo(() => {
    const citySet = new Set();
    const stopSet = new Set();

    (routeInventory || []).forEach((bus) => {
      [bus.from, bus.to].forEach((city) => {
        const normalizedCity = String(city || '').trim();
        if (normalizedCity) {
          citySet.add(normalizedCity);
        }
      });

      (bus.stops || []).forEach((stop) => {
        const stopName = getStopName(stop);
        if (stopName) {
          stopSet.add(stopName);
        }
      });
    });

    return {
      cities: Array.from(citySet).sort((left, right) => left.localeCompare(right)),
      stops: Array.from(stopSet).sort((left, right) => left.localeCompare(right)),
    };
  }, [routeInventory]);

  const handleBusScan = async (parsed, rawValue) => {
    try {
      setLoading(true);
      const embeddedBus = normalizeBusFromQr(parsed?.bus, parsed?.id);

      if (embeddedBus) {
        setSelectedBus(embeddedBus);
        const busStops = (embeddedBus.stops || []).map((stop) => getStopName(stop)).filter(Boolean);
        setBookingForm((current) => ({
          ...current,
          timingLabel: embeddedBus.timings?.[0]?.label || humanTimeRange(embeddedBus.startTime, embeddedBus.endTime),
          startStop: busStops[0] || '',
          endStop: busStops[busStops.length - 1] || '',
        }));
        setSearchValue(embeddedBus.busNumber || '');
        setScanBookingBusId(embeddedBus._id);
        setRouteInventory([embeddedBus]);
        setActiveTab('search');
        setPreviewBus(null);
        setSearchResults([]);
        setScannerOpen(false);
        return;
      }

      const data = await requestJson(`/buses/${parsed?.id}`, { token: session.token });
      if (!data.bus) {
        Alert.alert('Bus unavailable', 'This bus is not available right now.');
        return;
      }

      // Directly open booking flow for scanned bus: populate booking form and stay on the booking screen
      setSelectedBus(data.bus || null);
      const busStops = (data.bus.stops || []).map((stop) => getStopName(stop)).filter(Boolean);
      setBookingForm((current) => ({
        ...current,
        timingLabel: data.bus.timings?.[0]?.label || humanTimeRange(data.bus.startTime, data.bus.endTime),
        startStop: busStops[0] || '',
        endStop: busStops[busStops.length - 1] || '',
      }));
      setSearchValue(data.bus.busNumber || '');
      setScanBookingBusId(data.bus._id);
      setRouteInventory([data.bus]);
      setActiveTab('search');
      setPreviewBus(null);
      setSearchResults([]);
      setScannerOpen(false);
    } catch (error) {
      const isUnavailable = /bus not found|not available/i.test(String(error.message || ''));
      Alert.alert(isUnavailable ? 'Bus unavailable' : 'QR scan failed', isUnavailable ? 'This bus is not available right now.' : error.message);
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

      const routeStops = getBusRouteStops(selectedBus);
      const startIndex = routeStopIndex(routeStops, startStop);
      const endIndex = routeStopIndex(routeStops, endStop);

      console.log('DEBUG createBooking:', {
        selectedStartStop: startStop,
        selectedEndStop: endStop,
        routeStops,
        startIndex,
        endIndex,
      });

      if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        const debugMsg = startIndex === -1 ? `Start stop "${startStop}" not found in route` :
          endIndex === -1 ? `End stop "${endStop}" not found in route` :
            startIndex >= endIndex ? `End stop must be after start stop` : '';
        Alert.alert('Invalid route', `${debugMsg}\n\nAvailable stops: ${routeStops.join(', ')}`);
        return;
      }

      setLoading(true);

      // Check internet connectivity
      const hasInternet = await checkInternetConnectivity();

      if (!hasInternet) {
        // Save offline ticket
        const offlineTicket = buildOfflineTicketPayload({
          bus: selectedBus,
          bookingForm: {
            travelDate,
            timingLabel,
            startStop,
            endStop,
            seats,
          },
          userName: session.user?.name,
        });

        const localOfflineTicket = {
          _id: `offline_${Date.now()}`,
          ...offlineTicket,
          bus: offlineTicket.bus,
          status: 'pending',
          isOffline: true,
          createdAt: new Date().toISOString(),
        };

        const savedTicket = await saveOfflineTicket(localOfflineTicket, session.user._id);
        setTickets((current) => [savedTicket, ...current]);
        setSelectedTicketId(savedTicket._id);
        setSelectedBus(savedTicket.bus);
        setActiveTab('ticket');
        setShowOnlyCurrentBooked(true);
        Alert.alert('Offline Mode', 'Booking saved locally. It will sync when you are online.');
        return;
      }

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
      setShowOnlyCurrentBooked(true);
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

  const ticketTiming = useMemo(() => {
    if (!selectedTicket) {
      return '';
    }

    return String(selectedTicket.timingLabel || '').trim();
  }, [selectedTicket]);

  const ticketValidity = useMemo(() => {
    if (!selectedTicket) {
      return '';
    }

    return `${selectedTicket.travelDate} ${selectedTicket.timingLabel}`;
  }, [selectedTicket]);

  const isOtpVisible = useMemo(() => {
    if (!selectedTicket) {
      return false;
    }

    const now = new Date();
    const validFrom = new Date(selectedTicket.validFrom);
    const validTo = new Date(selectedTicket.validTo);

    // Check if current phone time is within validity window
    return now >= validFrom && now <= validTo;
  }, [selectedTicket]);

  const openLiveTracking = (ticketItem) => {
    setSelectedTicketId(ticketItem._id);
    setTrackingTicket(ticketItem);
  };

  const busStopNames = useMemo(() => {
    return getBusRouteStops(selectedBus);
  }, [selectedBus]);

  const selectedStartStop = bookingForm.startStop || '';
  const selectedEndStop = bookingForm.endStop || '';

  const displayedBus = selectedBus || previewBus;
  const hideBusPreview = Boolean(selectedBus && scanBookingBusId && selectedBus._id === scanBookingBusId);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <AppHeader
        session={session}
        onLogout={onLogout}
        onBusQrScanned={handleBusScan}
        menuActions={[
          { label: 'Search bus', onPress: () => { setShowOnlyCurrentBooked(false); setActiveTab('search'); } },
          { label: 'Ticket', onPress: () => { setShowOnlyCurrentBooked(false); setActiveTab('ticket'); } },
          { label: 'Sync tickets', onPress: () => { setShowOnlyCurrentBooked(false); manualSyncTickets(); } },
        ]}
      />

      {activeTab === 'search' ? (
        <>
          <Modal visible={locationPickerOpen} animationType="slide" onRequestClose={closeLocationPicker}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <View style={{ padding: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Pressable onPress={closeLocationPicker} style={styles.secondaryAction}>
                    <Text style={styles.secondaryActionText}>Back</Text>
                  </Pressable>
                  <SectionTitle
                    title={locationPickerMode === 'to' ? 'Choose destination' : 'Choose origin'}
                    description="Pick a city or stop name."
                  />
                  <View style={{ width: 60 }} />
                </View>

                <View style={{ marginBottom: 12 }}>
                  <Field
                    label="Search city or route"
                    value={locationPickerSearch}
                    onChangeText={setLocationPickerSearch}
                    placeholder="Search by city, route, or bus number"
                  />
                </View>

                {loadingLocations ? (
                  <Text style={[styles.helperText, { marginTop: 12 }]}>Loading cities and routes…</Text>
                ) : null}

                {!loadingLocations && !locationPickerItems.length ? (
                  <Text style={[styles.helperText, { marginTop: 12 }]}>No matching cities or stops found.</Text>
                ) : null}

                {locationPickerItems.map((item) => (
                  <Pressable key={item} style={styles.locationItemRow} onPress={() => selectLocation(item)}>
                    <Text style={styles.locationItemText}>{item}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </Modal>

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
            <View style={{ marginBottom: 12 }}>
              <View style={styles.splitRow}>
                <View style={{ flex: 1, position: 'relative' }}>
                  <Text style={styles.fieldLabel}>From</Text>
                  <Pressable style={styles.dropdownButton} onPress={() => openLocationPicker('from')}>
                    <Text style={[styles.dropdownButtonText, !fromSelection && styles.dropdownPlaceholder]}>{fromSelection || (loadingLocations ? 'Loading…' : 'Select origin')}</Text>
                  </Pressable>
                  <Text style={[styles.helperText, { marginTop: 6 }]}>{loadingLocations ? 'Loading cities and routes…' : 'Opens a full-screen city and route list.'}</Text>
                </View>
                <View style={{ flex: 1, position: 'relative' }}>
                  <Text style={styles.fieldLabel}>To</Text>
                  <Pressable style={styles.dropdownButton} onPress={() => openLocationPicker('to')}>
                    <Text style={[styles.dropdownButtonText, !toSelection && styles.dropdownPlaceholder]}>{toSelection || (loadingLocations ? 'Loading…' : 'Select destination')}</Text>
                  </Pressable>
                  <Text style={[styles.helperText, { marginTop: 6 }]}>{loadingLocations ? '' : 'Opens a full-screen city and route list.'}</Text>
                </View>
              </View>

              <View style={[styles.rowButtons, { marginTop: 12 }]}>
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
            </View>
            {searchResults.length ? (
              <View>
                <Text style={styles.helperText}>{searchResults.length} buses found</Text>
                {searchResults.map((bus) => {
                  const crowd = getBusCrowdPresentation(bus);
                  return (
                    <Pressable key={bus._id} onPress={() => openBusBooking(bus)} style={({ pressed }) => [styles.busSearchResultPressable, pressed && styles.busSearchResultPressableActive]}>
                      <Card style={styles.busSearchResultCard}>
                        <View style={styles.busTopRow}>
                          <View>
                            <Text style={styles.busSearchResultTitle}>Bus {bus.busNumber}</Text>
                            <Text style={styles.busSearchResultSeats}>{bus.from} → {bus.to}</Text>
                          </View>
                          <View style={styles.crowdStatusBadge}>
                            <View style={[styles.crowdStatusDot, { backgroundColor: crowd.color }]} />
                            <Text style={styles.crowdStatusText}>{crowd.label}</Text>
                          </View>
                        </View>
                      </Card>
                    </Pressable>
                  );
                })}
              </View>
            ) : displayedBus && !hideBusPreview ? (
              <BusDetailsCard
                bus={displayedBus}
                onStartBooking={() => {
                  openBusBooking(displayedBus);
                }}
              />
            ) : null}
          </Card>
        </>
      ) : null}

      {selectedBus ? (
        <Card>
          <Text style={styles.cardSubtitle}>Bus {selectedBus.busNumber}</Text>
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

          <View style={styles.splitRow}>
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Start stop</Text>
              <Pressable style={styles.dropdownButton} onPress={() => { setStopPickerType('start'); setStopPickerOpen(true); }}>
                <Text style={[styles.dropdownButtonText, !selectedStartStop && styles.dropdownPlaceholder]}>
                  {selectedStartStop || 'Select start stop'}
                </Text>
              </Pressable>
            </View>
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>End stop</Text>
              <Pressable style={styles.dropdownButton} onPress={() => { setStopPickerType('end'); setStopPickerOpen(true); }}>
                <Text style={[styles.dropdownButtonText, !selectedEndStop && styles.dropdownPlaceholder]}>
                  {selectedEndStop || 'Select end stop'}
                </Text>
              </Pressable>
            </View>
          </View>

          <PrimaryButton label={`Just Pay ${currencyText(Number(bookingForm.seats) * 249)}`} onPress={createBooking} loading={loading} />
        </Card>
      ) : null}

      <Modal visible={stopPickerOpen} transparent animationType="fade" onRequestClose={() => setStopPickerOpen(false)}>
        <View style={styles.centeredBackdrop}>
          <View style={styles.assignModalBox}>
            <Text style={styles.cardTitle1}>{stopPickerType === 'start' ? 'Select start stop' : 'Select end stop'}</Text>
            <ScrollView style={{ maxHeight: 260, marginTop: 12 }}>
              {busStopNames.map((stopName, index) => (
                <Pressable
                  key={`${stopPickerType}-${index}-${stopName}`}
                  style={styles.assignListItem}
                  onPress={() => {
                    setBookingForm((current) => ({
                      ...current,
                      ...(stopPickerType === 'start' ? { startStop: stopName } : { endStop: stopName }),
                    }));
                    setStopPickerOpen(false);
                  }}
                >
                  <Text style={styles.cardTitle1}>{stopName}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={{ marginTop: 12 }}>
              <Pressable style={styles.secondaryAction} onPress={() => setStopPickerOpen(false)}>
                <Text style={styles.secondaryActionText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {activeTab === 'ticket' ? (
        <Card>
          <SectionTitle title="Your tickets" description="All booked tickets are listed here. Select one to show QR and OTP." />
          {displayedTickets.length ? (
            <>
              <View style={styles.ticketListWrap}>
                {displayedTickets.map((ticketItem) => {
                  const isSelected = (selectedTicket?._id || '') === ticketItem._id;

                  return (
                    <View key={ticketItem._id} style={[styles.ticketListItem, isSelected && styles.ticketListItemActive]}>
                      <View style={styles.busTopRow}>
                        <View style={styles.ticketListHeader}>
                          <Text style={styles.cardTitle}>{ticketItem.bus?.busNumber || 'BUS'}</Text>
                          <Text style={styles.cardSubtitle}>{ticketItem.travelDate} • {ticketItem.startStop} to {ticketItem.endStop}</Text>
                          <Text style={styles.helperText}>Timing: {String(ticketItem.timingLabel || '').trim() || 'n/a'}</Text>
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
                    {isOtpVisible ? (
                      <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{selectedTicket.otp}</Text></View>
                    ) : (
                      <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValueSmall}>Hidden (outside validity)</Text></View>
                    )}
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Status</Text><Text style={styles.ticketMetaValue}>{selectedTicket.status}</Text></View>
                    <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Timing</Text><Text style={styles.ticketMetaValueSmall}>{ticketTiming || 'n/a'}</Text></View>
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

      {trackingTicket ? <LiveTrackingPanel ticket={trackingTicket} onClose={() => setTrackingTicket(null)} trackingUrl={trackingUrl} /> : null}
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

    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: 1000 * 60 * 5,
      requiredAccuracy: 200,
    });

    if (lastKnown) {
      return {
        lat: lastKnown.coords.latitude,
        lng: lastKnown.coords.longitude,
      };
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      mayShowUserSettingsDialog: true,
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

function getBusRouteStops(bus) {
  if (!bus || typeof bus !== 'object') {
    return [];
  }

  const routeStops = [];
  const from = String(bus.from || '').trim();
  const to = String(bus.to || '').trim();

  if (from) {
    routeStops.push(from);
  }

  if (Array.isArray(bus.stops)) {
    bus.stops.forEach((stop) => {
      const stopName = getStopName(stop);
      if (stopName && stopName !== routeStops[routeStops.length - 1]) {
        routeStops.push(stopName);
      }
    });
  }

  if (to && to !== routeStops[routeStops.length - 1]) {
    routeStops.push(to);
  }

  return routeStops;
}

function getBusCrowdPresentation(bus) {
  const seatCount = Number(bus?.seats || 0);
  const availableSeats = Number(bus?.availableSeats ?? seatCount);
  const percent = seatCount > 0 ? Math.round((availableSeats / seatCount) * 100) : 0;
  let label = String(bus?.crowdStatus || '').trim();
  let color = bus?.crowdColor || '#22C55E';

  if (!label) {
    if (percent >= 100) {
      label = 'no crowded';
      color = '#22C55E';
    } else if (percent >= 50) {
      label = 'less crowded';
      color = '#EAB308';
    } else {
      label = 'most crowded';
      color = '#EF4444';
    }
  }

  return { label, color };
}

function AdminDashboard({ session, onLogout, trackingUrl, onTrackingUrlChange }) {
  const [activeTab, setActiveTab] = useState('add');
  const [form, setForm] = useState(busInitialState);
  const [loading, setLoading] = useState(false);
  const [savedBus, setSavedBus] = useState(null);
  const [busList, setBusList] = useState([]);
  const [busSearch, setBusSearch] = useState('');
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assigningBus, setAssigningBus] = useState(null);
  const [conductors, setConductors] = useState([]);
  const [conductorSearch, setConductorSearch] = useState('');
  const [loadingConductors, setLoadingConductors] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerPurpose, setScannerPurpose] = useState('ticket');
  const [verifiedTicket, setVerifiedTicket] = useState(null);
  const [otpVerify, setOtpVerify] = useState('');
  const [trackingInput, setTrackingInput] = useState(trackingUrl || '');
  const [trackingSaving, setTrackingSaving] = useState(false);
  const [trackingMessage, setTrackingMessage] = useState('');

  useEffect(() => {
    setTrackingInput(trackingUrl || '');
  }, [trackingUrl]);

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

  const filteredBuses = (() => {
    const filter = String(busSearch || '').trim().toLowerCase();
    return filter ? busList.filter((b) => (`${b.busNumber} ${b.from} ${b.to}`.toLowerCase().includes(filter))) : busList;
  })();

  const openAssignModal = async (bus) => {
    setAssigningBus(bus);
    setAssignModalOpen(true);
    try {
      setLoadingConductors(true);
      const data = await requestJson('/users?role=conductor', { token: session.token });
      setConductors(data.users || []);
    } catch (err) {
      Alert.alert('Failed to load conductors', err.message);
      setConductors([]);
    } finally {
      setLoadingConductors(false);
    }
  };

  const closeAssignModal = () => {
    setAssignModalOpen(false);
    setAssigningBus(null);
    setConductors([]);
    setConductorSearch('');
  };

  const assignConductor = async (conductorId) => {
    if (!assigningBus) return;
    try {
      setLoading(true);
      await requestJson(`/buses/${assigningBus._id}/assign-conductor`, { method: 'POST', token: session.token, body: { conductorId } });
      refreshBuses();
      closeAssignModal();
      Alert.alert('Assigned', 'Conductor assigned successfully');
    } catch (err) {
      Alert.alert('Assign failed', err.message);
    } finally {
      setLoading(false);
    }
  };

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
          conductorId: form.conductorId || undefined,
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
        body: { qrToken: rawValue || `ticket:${id}`, clientTime: new Date().toISOString() },
      });
      // Successful verification: vibrate once and continue scanning
      try {
        Vibration.vibrate(100);
      } catch (e) {
        console.log('Vibration failed', e);
      }

      const booking = data?.booking;
      const passengerName = booking?.user?.name || booking?.offlinePayload?.userName || 'N/A';
      const fromStop = booking?.startStop || 'N/A';
      const toStop = booking?.endStop || 'N/A';

      Alert.alert(
        'Ticket vierified successfully',
        `User Name: ${passengerName}\nFrom: ${fromStop}\nTo: ${toStop}`
      );
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

  const saveTrackingUrl = async () => {
    try {
      setTrackingSaving(true);
      setTrackingMessage('');
      const nextUrl = normalizeRemoteUrl(trackingInput);

      const data = await requestJson('/settings/tracking-url', {
        method: 'PUT',
        token: session.token,
        body: { trackingUrl: nextUrl },
      });

      const savedUrl = data.trackingUrl || nextUrl;
      setTrackingInput(savedUrl);
      onTrackingUrlChange?.(savedUrl);
      setTrackingMessage('Tracking URL saved.');
      Alert.alert('Saved', 'Public tracking URL updated successfully.');
    } catch (error) {
      Alert.alert('Save failed', error.message);
    } finally {
      setTrackingSaving(false);
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
          {/* Conductor assignment moved to Bus list for later assignment */}
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
                  body: { otp: otpVerify, clientTime: new Date().toISOString() },
                });

                setVerifiedTicket(data.booking);
                setScannerOpen(false);
                setActiveTab('verify');
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
        <SectionTitle title="Bus list" description="Search and manage buses stored in the local MongoDB collection." />
        <Field label="Search buses" value={busSearch} onChangeText={setBusSearch} placeholder="Search by bus number, from, or to" />
        <View style={{ marginTop: 8 }}>
          {filteredBuses.length ? (
            filteredBuses.map((bus) => {
              const routeStops = getBusRouteStops(bus);
              return (
                <Card key={bus._id} style={{ marginBottom: 8 }}>
                  <View style={styles.busTopRow}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.cardTitle}>Bus {bus.busNumber}</Text>
                      <Text style={styles.cardSubtitle}>{bus.from} → {bus.to}</Text>
                      <Text style={styles.helperText}>Conductor: {bus.conductor ? bus.conductor.name : 'Unassigned'}</Text>
                      <Text style={styles.adminBusRouteText}>{routeStops.join(' → ')}</Text>
                    </View>
                    <View style={styles.adminBusQrWrap}>
                      {bus.qrDataUrl ? (
                        <Image source={{ uri: bus.qrDataUrl }} style={styles.adminBusQrImage} />
                      ) : (
                        <View style={styles.adminBusQrPlaceholder}><Text style={styles.adminBusQrPlaceholderText}>QR</Text></View>
                      )}
                    </View>
                  </View>
                  <View style={styles.adminBusCardFooter}>
                    <Pressable style={styles.secondaryAction} onPress={() => openAssignModal(bus)}>
                      <Text style={styles.secondaryActionText}>Assign conductor</Text>
                    </Pressable>
                  </View>
                </Card>
              );
            })
          ) : <Text style={styles.helperText}>No buses saved yet.</Text>}
        </View>
      </Card>

      <Card>
        <SectionTitle title="Live tracking source" description="Set the public URL that serves the live bus position JSON, for example https://your-server.com/data." />
        <Field
          label="Public tracking URL"
          value={trackingInput}
          onChangeText={setTrackingInput}
          placeholder="https://your-server.com/data"
          autoCapitalize="none"
          keyboardType="url"
        />
        <View style={styles.rowButtons}>
          <PrimaryButton label="Save tracking URL" onPress={saveTrackingUrl} loading={trackingSaving} style={styles.flexButton} />
        </View>
        {trackingMessage ? <Text style={styles.helperText}>{trackingMessage}</Text> : null}
      </Card>

      <Modal visible={assignModalOpen} transparent animationType="fade" onRequestClose={closeAssignModal}>
        <View style={styles.centeredBackdrop}>
          <View style={styles.assignModalBox}>
            <Text style={styles.cardTitle}>Assign conductor</Text>
            <Text style={styles.cardSubtitle}>{assigningBus ? `${assigningBus.busNumber} — ${assigningBus.from} → ${assigningBus.to}` : ''}</Text>
            <View style={{ marginTop: 12 }}>
              <Field label="" value={conductorSearch} onChangeText={setConductorSearch} placeholder="Search conductors by name or email" />
            </View>
            <View style={styles.assignListBox}>
              <ScrollView>
                {loadingConductors ? <View style={{ padding: 12 }}><Text style={styles.helperText}>Loading...</Text></View> : null}
                {(conductors || []).filter((c) => (`${c.name} ${c.email}`).toLowerCase().includes((conductorSearch || '').toLowerCase())).map((c) => (
                  <Pressable key={c._id} style={styles.assignListItem} onPress={() => assignConductor(c._id)}>
                    <Text style={styles.cardTitle}>{c.name}</Text>
                    <Text style={styles.helperText}>{c.email}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
            <View style={{ marginTop: 12 }}>
              <Pressable style={styles.secondaryAction} onPress={closeAssignModal}><Text style={styles.secondaryActionText}>Cancel</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function ConductorDashboard({ session, onLogout }) {
  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState({});
  const [busVisibilityLoading, setBusVisibilityLoading] = useState({});
  const [scannerOpen, setScannerOpen] = useState(false);
  const [verificationFlash, setVerificationFlash] = useState(null);

  const refreshBuses = async () => {
    try {
      setLoading(true);
      const data = await requestJson(`/buses?conductorId=${session.user._id}`, { token: session.token });
      setBuses(data.buses || []);
    } catch (error) {
      Alert.alert('Could not load assigned buses', error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refreshBuses(); }, []);

  useEffect(() => {
    if (!verificationFlash) {
      return undefined;
    }

    const timer = setTimeout(() => setVerificationFlash(null), 1500);
    return () => clearTimeout(timer);
  }, [verificationFlash]);

  const updateBusLocation = async (busId) => {
    try {
      setLoading(true);
      const coords = await getStopLocation();
      if (!coords) return;
      const data = await requestJson(`/buses/${busId}/location`, {
        method: 'POST', token: session.token, body: { lat: coords.lat, lng: coords.lng }
      });
      Alert.alert('Location updated');
      refreshBuses();
    } catch (error) {
      Alert.alert('Update failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const updateStopLocation = async (busId, stopIndex) => {
    try {
      const key = `${busId}-${stopIndex}`;
      setStopLoading((s) => ({ ...s, [key]: true }));
      const coords = await getStopLocation();
      if (!coords) {
        setStopLoading((s) => ({ ...s, [key]: false }));
        return;
      }
      await requestJson(`/buses/${busId}/stops/${stopIndex}/location`, { method: 'POST', token: session.token, body: { lat: coords.lat, lng: coords.lng } });
      Alert.alert('Stop location updated');
      refreshBuses();
    } catch (error) {
      Alert.alert('Update failed', error.message);
    } finally {
      const key = `${busId}-${stopIndex}`;
      setStopLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const updateBusVisibility = async (busId, nextVisible) => {
    try {
      setBusVisibilityLoading((current) => ({ ...current, [busId]: true }));
      await requestJson(`/buses/${busId}/visibility`, {
        method: 'POST',
        token: session.token,
        body: { isVisible: nextVisible },
      });
      refreshBuses();
    } catch (error) {
      Alert.alert('Visibility update failed', error.message);
    } finally {
      setBusVisibilityLoading((current) => ({ ...current, [busId]: false }));
    }
  };

  const handleTicketScan = async ({ id }, rawValue) => {
    try {
      setLoading(true);
      const data = await requestJson('/bookings/verify', {
        method: 'POST',
        token: session.token,
        body: { qrToken: rawValue || `ticket:${id}`, clientTime: new Date().toISOString() },
      });
      try { Vibration.vibrate(100); } catch (e) { }
      setVerificationFlash({
        title: 'Done',
        message: 'Ticket verified successfully.',
      });

      const booking = data?.booking;
      const passengerName = booking?.user?.name || booking?.offlinePayload?.userName || 'N/A';
      const fromStop = booking?.startStop || 'N/A';
      const toStop = booking?.endStop || 'N/A';

      Alert.alert(
        'Ticket vierified successfully',
        `User Name: ${passengerName}\nFrom: ${fromStop}\nTo: ${toStop}`
      );
    } catch (error) {
      Alert.alert('Verification failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <AppHeader session={session} onLogout={onLogout} />
      <Card>
        <SectionTitle title="Assigned buses" description="Buses assigned to you. Update stop locations or verify tickets." />
        {verificationFlash ? (
          <View style={styles.doneBanner}>
            <Text style={styles.doneBannerTitle}>{verificationFlash.title}</Text>
            <Text style={styles.doneBannerText}>{verificationFlash.message}</Text>
          </View>
        ) : null}
        {buses.length ? buses.map((bus) => (
          <View key={bus._id} style={{ marginBottom: 12 }}>
            <Text style={styles.cardTitle}>Bus {bus.busNumber}</Text>
            <Text style={styles.cardSubtitle}>{bus.from} → {bus.to}</Text>
            <View style={{ marginTop: 10 }}>
              <Text style={styles.fieldLabel}>Visible in user app</Text>
              <View style={styles.switchRow}>
                <Text style={styles.switchText}>{(bus.isVisible ?? true) ? 'Visible' : 'Hidden'}</Text>
                <Switch
                  value={bus.isVisible ?? true}
                  onValueChange={(nextValue) => updateBusVisibility(bus._id, nextValue)}
                  disabled={!!busVisibilityLoading[bus._id]}
                />
              </View>
            </View>
            <Text style={styles.sectionMiniLabel}>Stops</Text>
            {(() => {
              const hasStopCoordinates = (stop) => (
                typeof stop?.lat === 'number'
                && typeof stop?.lng === 'number'
                && stop.lat !== 0
                && stop.lng !== 0
              );

              const allStopCoordinatesFilled = Array.isArray(bus.stops)
                && bus.stops.length > 0
                && bus.stops.every(hasStopCoordinates);

              const routeLabel = (bus.stops || [])
                .map((stop) => getStopName(stop))
                .filter(Boolean)
                .join(' -> ');

              if (allStopCoordinatesFilled) {
                return (
                  <View style={styles.stopRoutePill}>
                    <Text style={styles.stopRouteText}>{routeLabel || `${bus.from} -> ${bus.to}`}</Text>
                  </View>
                );
              }

              return (bus.stops || []).map((stop, idx) => (
                <View key={`stop-${idx}`} style={styles.stopContainer}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>{getStopName(stop)}</Text>
                    <Text style={styles.helperText}>{hasStopCoordinates(stop) ? `${stop.lat.toFixed(6)}, ${stop.lng.toFixed(6)}` : '0, 0'}</Text>
                  </View>
                  {hasStopCoordinates(stop) ? null : (
                    <Pressable style={styles.getLocationButton} onPress={() => updateStopLocation(bus._id, idx)} disabled={!!stopLoading[`${bus._id}-${idx}`]}>
                      {stopLoading[`${bus._id}-${idx}`] ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.getLocationButtonText}>Get location</Text>
                      )}
                    </Pressable>
                  )}
                </View>
              ));
            })()}

            <View style={{ marginTop: 12, alignItems: 'center' }}>
              <PrimaryButton label="Open ticket scanner" onPress={() => { setScannerOpen(true); }} style={styles.centerScannerButton} />
            </View>
          </View>
        )) : <Text style={styles.helperText}>No buses assigned to you.</Text>}
      </Card>

      {scannerOpen ? (
        <ScannerPanel
          purpose="ticket"
          label="Scan ticket QR"
          description="Scan a passenger ticket to verify"
          onClose={() => setScannerOpen(false)}
          onMatch={handleTicketScan}
        />
      ) : null}
    </ScrollView>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [trackingUrl, setTrackingUrl] = useState('');

  useEffect(() => {
    let isActive = true;

    const loadTrackingUrl = async () => {
      if (!session?.token) {
        if (isActive) {
          setTrackingUrl('');
        }
        return;
      }

      try {
        const data = await requestJson('/settings/tracking-url', { token: session.token });
        if (isActive) {
          setTrackingUrl(normalizeRemoteUrl(data.trackingUrl));
        }
      } catch {
        if (isActive) {
          setTrackingUrl('');
        }
      }
    };

    loadTrackingUrl();

    return () => {
      isActive = false;
    };
  }, [session?.token]);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />
      <View style={styles.bgBlobOne} />
      <View style={styles.bgBlobTwo} />
      <View style={styles.appShell}>
        <ScrollView contentContainerStyle={styles.screenContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); setRefreshSignal((s) => s + 1); setTimeout(() => setRefreshing(false), 900); }} tintColor="#FFFFFF" />}>
          {!session ? (
            <>
              <AppHeader />
              <AuthScreen onAuthed={setSession} />
            </>
          ) : session.user.role === 'admin' ? (
            <AdminDashboard session={session} onLogout={() => setSession(null)} refreshSignal={refreshSignal} trackingUrl={trackingUrl} onTrackingUrlChange={setTrackingUrl} />
          ) : session.user.role === 'conductor' ? (
            <ConductorDashboard session={session} onLogout={() => setSession(null)} refreshSignal={refreshSignal} />
          ) : (
            <UserDashboard session={session} onLogout={() => setSession(null)} refreshSignal={refreshSignal} trackingUrl={trackingUrl} />
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  doneBanner: {
    marginTop: 12,
    marginBottom: 12,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#12391F',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.35)',
  },
  doneBannerTitle: {
    color: '#86EFAC',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  doneBannerText: {
    marginTop: 4,
    color: '#DCFCE7',
    fontSize: 14,
    fontWeight: '600',
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
  },
  headerBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerBrandLogo: {
    width: 44,
    height: 44,
    borderRadius: 14,
  },
  headerBrandTitle: {
    color: '#F8FAFC',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  headerBrandSubtitle: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
  },
  headerBrandSpacer: {
    width: 44,
    height: 44,
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
    alignItems: 'flex-end',
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
    left: 20
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
  ghostIcon: {
    borderWidth: 1,
    borderColor: 'rgba(125, 211, 252, 0.35)',
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostIconImage: {
    width: 24,
    height: 24,
    resizeMode: 'contain',
    color: '#F8FAFC',
    backgroundColor: '#F8FAFC'
  },
  ghostIconText: {
    color: '#BAE6FD',
    fontSize: 18,
  },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 17, 31, 0.55)',
  },
  drawerScrim: {
    ...StyleSheet.absoluteFillObject,
  },
  drawerHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(248,250,252,0.18)',
    alignSelf: 'flex-start',
  },
  leftDrawer: {
    width: 286,
    height: '100%',
    backgroundColor: '#081427',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
    gap: 14,
    borderRightWidth: 1,
    borderRightColor: 'rgba(148,163,184,0.14)',
  },
  drawerTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '900',
  },
  drawerSection: {
    gap: 10,
    marginTop: 6,
  },
  drawerItem: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(148,163,184,0.08)',
  },
  drawerItemText: {
    color: '#F8FAFC',
    fontWeight: '800',
    fontSize: 15,
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
  cardTitle1: {
    color: '#ffffff',
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
  centerScannerButton: {
    minWidth: 220,
    alignSelf: 'center',
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
  crowdStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  crowdStatusDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  crowdStatusText: {
    color: '#0F172A',
    fontWeight: '700',
    fontSize: 12,
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
  dashboardMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 4,
  },
  hamburgerButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#0B162B',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  headerMenuButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#0B162B',
    borderWidth: 1,
    borderColor: 'rgba(125, 211, 252, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  hamburgerLine: {
    width: 17,
    height: 2,
    borderRadius: 999,
    backgroundColor: '#F8FAFC',
  },
  dashboardMenuLabel: {
    flex: 1,
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'right',
  },
  busSearchResultPressable: {
    marginBottom: 10,
  },
  busSearchResultPressableActive: {
    opacity: 0.85,
  },
  routeSummaryCard: {
    backgroundColor: '#0B172A',
    borderColor: 'rgba(125, 211, 252, 0.18)',
  },
  busSearchResultCard: {
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  busSearchResultTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '800',
  },
  busSearchResultSeats: {
    color: '#475569',
    fontSize: 13,
    marginTop: 2,
  },
  adminBusRouteText: {
    color: '#475569',
    fontSize: 13,
    marginTop: 8,
    lineHeight: 18,
  },
  adminBusQrWrap: {
    width: 86,
    minHeight: 86,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#F8FAFC',
  },
  adminBusQrImage: {
    width: 82,
    height: 82,
    borderRadius: 12,
    resizeMode: 'contain',
  },
  adminBusQrPlaceholder: {
    width: 82,
    height: 82,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E2E8F0',
  },
  adminBusQrPlaceholderText: {
    color: '#475569',
    fontWeight: '700',
  },
  adminBusCardFooter: {
    marginTop: 12,
    alignItems: 'flex-end',
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
  stopRoutePill: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(125, 211, 252, 0.22)',
  },
  stopRouteText: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
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
  centeredBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  assignModalBox: {
    width: '90%',
    maxWidth: 540,
    backgroundColor: '#07111F',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.12)'
  },
  assignListItem: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)'
  },
  assignListBox: {
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.06)',
    borderRadius: 8,
    backgroundColor: '#041021',
    marginTop: 8,
    maxHeight: 260,
    paddingHorizontal: 6,
  },
  overlayDropdown: {
    position: 'absolute',
    top: 56,
    left: 0,
    right: 0,
    zIndex: 2000,
    elevation: 20,
    paddingHorizontal: 6,
  },
  overlayDropdownBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 10,
    maxHeight: 220,
    overflow: 'hidden',
  },
  locationSectionCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.14)',
    padding: 12,
    marginBottom: 12,
    gap: 10,
  },
  locationCityButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#E0F2FE',
  },
  locationRouteList: {
    gap: 8,
  },
  locationStopList: {
    gap: 8,
  },
  locationRouteRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  locationRouteBus: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '800',
  },
  locationRouteLabel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
  },
  locationStopRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  locationStopText: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '700',
  },
  locationItemRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
  },
  locationItemText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '700',
  },
  dropdownButton: {
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.16)',
    backgroundColor: '#0B162B',
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  dropdownButtonText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  dropdownPlaceholder: {
    color: '#94A3B8',
    fontWeight: '600',
  },
});
