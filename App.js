import { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Animated, BackHandler, Image, KeyboardAvoidingView, Modal, NativeModules, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View, Vibration, ActivityIndicator, RefreshControl, Dimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import SvgQRCode from 'react-native-qrcode-svg';
import * as Location from 'expo-location';
import { WebView } from 'react-native-webview';
import DateTimePicker from '@react-native-community/datetimepicker';

//npx expo prebuild
//cd android
//./gradlew assembleDebug

// npx eas-cli@latest build -p android --profile preview

// eas build --platform android --profile production
// eas update --branch production --message "Your update message"


/*
Step-by-step OTA Updates Setup (from scratch):

1. Install EAS CLI:

bash
npm install -g eas-cli
eas login
2. Configure EAS for your project:

bash
eas build:configure
This adds EAS configuration to your project.

3. Build your first APK (production):

bash
eas build --platform android --profile production
This creates your production APK
Install this APK on your device
This is your base app that will receive OTA updates
4. Make code changes:

Edit your code (App.js, etc.)
Test locally with expo start
5. Publish OTA update:

bash
eas update --branch production --message "Your update message"
6. Users get update:

Open the app (or restart)
Changes appear automatically
Important Notes:

First APK build is required (one-time)
After that, only OTA updates needed
OTA updates work for JavaScript/assets only
Native changes (camera, location) need new APK
Your app.json already has OTA configured, so you can skip the configuration steps and go directly to building your first APK, then use eas update for subsequent changes.
*/

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

function formatDateOnly(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const TICKET_FARE = 20;

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

  const compactStops = Array.isArray(parsedBus.s)
    ? parsedBus.s.map((stop) => {
      if (typeof stop === 'string') {
        return stop;
      }

      if (stop && typeof stop === 'object') {
        return {
          name: stop.n || stop.name || '',
          lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : 0,
          lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : 0,
        };
      }

      return '';
    }).filter(Boolean)
    : null;

  const compactTimings = Array.isArray(parsedBus.t)
    ? parsedBus.t.map((timing) => {
      if (typeof timing === 'string') {
        return { label: timing };
      }

      if (timing && typeof timing === 'object') {
        return {
          label: timing.l || timing.label || '',
        };
      }

      return null;
    }).filter(Boolean)
    : null;

  const normalizedStops = compactStops || (Array.isArray(parsedBus.stops) ? parsedBus.stops : []);
  const normalizedTimings = compactTimings || (Array.isArray(parsedBus.timings) ? parsedBus.timings : []);

  return {
    ...parsedBus,
    _id: parsedBus._id || parsedId,
    busNumber: parsedBus.n || parsedBus.busNumber || '',
    from: parsedBus.f || parsedBus.from || '',
    to: parsedBus.tn || parsedBus.to || '',
    startTime: parsedBus.st || parsedBus.startTime || '',
    endTime: parsedBus.et || parsedBus.endTime || '',
    startPeriod: parsedBus.sp || parsedBus.startPeriod || '',
    endPeriod: parsedBus.ep || parsedBus.endPeriod || '',
    seats: parsedBus.se || parsedBus.seats || '',
    availableSeats: parsedBus.as || parsedBus.availableSeats,
    busType: parsedBus.bt || parsedBus.busType || '',
    crowdStatus: parsedBus.cs || parsedBus.crowdStatus || '',
    crowdColor: parsedBus.cc || parsedBus.crowdColor || '',
    stops: normalizedStops,
    timings: normalizedTimings,
  };
}

function buildBusQrValue(bus) {
  if (!bus || typeof bus !== 'object') {
    return '';
  }

  const compactStops = (Array.isArray(bus.stops) ? bus.stops : [])
    .map((stop) => {
      const stopName = getStopName(stop).trim();

      if (!stopName) {
        return null;
      }

      const lat = Number(stop?.lat);
      const lng = Number(stop?.lng);

      return {
        n: stopName,
        ...(Number.isFinite(lat) && lat !== 0 ? { lat } : {}),
        ...(Number.isFinite(lng) && lng !== 0 ? { lng } : {}),
      };
    })
    .filter(Boolean);

  const compactTimings = (Array.isArray(bus.timings) ? bus.timings : [])
    .map((timing) => {
      const label = String(timing?.label || timing || '').trim();
      return label ? { l: label } : null;
    })
    .filter(Boolean);

  return JSON.stringify({
    type: 'bus',
    id: bus._id,
    bus: {
      _id: bus._id,
      n: String(bus.busNumber || '').trim(),
      f: String(bus.from || '').trim(),
      tn: String(bus.to || '').trim(),
      st: String(bus.startTime || '').trim(),
      et: String(bus.endTime || '').trim(),
      sp: String(bus.startPeriod || '').trim(),
      ep: String(bus.endPeriod || '').trim(),
      se: Number(bus.seats || 0),
      as: Number(bus.availableSeats ?? bus.seats ?? 0),
      bt: String(bus.busType || '').trim(),
      cs: String(bus.crowdStatus || '').trim(),
      cc: String(bus.crowdColor || '').trim(),
      s: compactStops,
      t: compactTimings,
    },
  });
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
        throw new Error(backendMessage);
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

function findStopByName(stops, selectedStop) {
  const normalizedStop = normalizeRouteStop(selectedStop);
  return (Array.isArray(stops) ? stops : []).find((stop) => normalizeRouteStop(getStopName(stop)) === normalizedStop) || null;
}

function formatArrivalEstimate(distanceKm, averageSpeedKmh = 25) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    return '';
  }

  const minutes = Math.max(1, Math.round((distanceKm / averageSpeedKmh) * 60));
  return minutes <= 1 ? 'Arriving now' : `~${minutes} min`;
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

function buildMapEmbedUrl(latitude, longitude, userLat, userLng) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const userLatNum = Number(userLat);
  const userLngNum = Number(userLng);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  const latDelta = 0.0005;
  const lngDelta = 0.0005;
  const left = lng - lngDelta;
  const right = lng + lngDelta;
  const top = lat + latDelta;
  const bottom = lat - latDelta;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body { margin: 0; padding: 0; }
    #map { height: 100vh; width: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map').setView([${lat}, ${lng}], 18);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
    
    var busIcon = L.divIcon({
      className: 'custom-div-icon',
      html: '<div style="background-color: #EF4444; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    
    var userIcon = L.divIcon({
      className: 'custom-div-icon',
      html: '<div style="background-color: #10B981; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
    
    L.marker([${lat}, ${lng}], {icon: busIcon}).addTo(map).bindPopup('Bus Location');
    ${userLat && !Number.isNaN(userLatNum) && userLng && !Number.isNaN(userLngNum) ?
      `L.marker([${userLatNum}, ${userLngNum}], {icon: userIcon}).addTo(map).bindPopup('Your Location');` : ''}
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildSimpleMapUrl(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body { margin: 0; padding: 0; }
    #map { height: 100vh; width: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map').setView([${lat}, ${lng}], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const LIVE_MAP_CIRCLE_RADIUS = Math.round(Math.min(Dimensions.get('window').width, Dimensions.get('window').height) * 0.39);

function getBusesWithCurrentLocation(buses) {
  return (buses || []).filter((bus) => {
    const lat = Number(bus?.currentLocation?.lat);
    const lng = Number(bus?.currentLocation?.lng);
    return Number.isFinite(lat) && lat !== 0 && Number.isFinite(lng) && lng !== 0;
  });
}

function buildLiveBusesMapUrl(latitude, longitude, buses, circleRadiusPx = LIVE_MAP_CIRCLE_RADIUS) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  const busesData = getBusesWithCurrentLocation(buses).map((bus) => ({
    id: String(bus._id),
    busNumber: String(bus.busNumber || ''),
    lat: Number(bus.currentLocation.lat),
    lng: Number(bus.currentLocation.lng),
  }));

  const busesJson = JSON.stringify(busesData);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body { margin: 0; padding: 0; }
    #map { height: 100vh; width: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var CIRCLE_RADIUS_PX = ${Number(circleRadiusPx)};
    var allBuses = ${busesJson};
    var markers = {};
    var map = L.map('map', { zoomControl: false }).setView([${lat}, ${lng}], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    function haversineMeters(lat1, lng1, lat2, lng2) {
      var R = 6371000;
      var dLat = (lat2 - lat1) * Math.PI / 180;
      var dLng = (lng2 - lng1) * Math.PI / 180;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function getSearchRadiusMeters() {
      var mapSize = map.getSize();
      var centerPt = mapSize.divideBy(2);
      var edgePt = L.point(centerPt.x + CIRCLE_RADIUS_PX, centerPt.y);
      return map.distance(
        map.containerPointToLatLng(centerPt),
        map.containerPointToLatLng(edgePt)
      );
    }

    function createBusIcon(busNumber) {
      return L.divIcon({
        className: 'live-bus-marker',
        html: '<div style="display:flex;align-items:center;gap:4px;background:#1565C0;color:#fff;font-size:11px;font-weight:700;padding:4px 8px 4px 6px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.28);white-space:nowrap;border:2px solid #fff;"><span style="font-size:12px;line-height:1;">🚌</span><span>' + busNumber + '</span></div>',
        iconSize: [0, 0],
        iconAnchor: [0, 16],
      });
    }

    function postToApp(payload) {
      var serialized = JSON.stringify(payload);
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(serialized);
      }
    }

    function updateMarkers() {
      var center = map.getCenter();
      var radiusM = getSearchRadiusMeters();
      var visible = [];

      Object.keys(markers).forEach(function(id) {
        map.removeLayer(markers[id]);
      });
      markers = {};

      allBuses.forEach(function(bus) {
        var dist = haversineMeters(center.lat, center.lng, bus.lat, bus.lng);
        if (dist <= radiusM) {
          var marker = L.marker([bus.lat, bus.lng], { icon: createBusIcon(bus.busNumber) }).addTo(map);
          marker.on('click', function() {
            postToApp({ type: 'busTapped', busId: bus.id });
          });
          markers[bus.id] = marker;
          visible.push(bus);
        }
      });

      postToApp({
        type: 'visibleBuses',
        buses: visible,
        center: { lat: center.lat, lng: center.lng },
        radiusM: radiusM,
      });
    }

    function handleRNMessage(event) {
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'updateBuses' && Array.isArray(data.buses)) {
          allBuses = data.buses;
          updateMarkers();
        }
        if (data.type === 'recenter' && data.lat && data.lng) {
          map.setView([data.lat, data.lng], map.getZoom() || 15);
          updateMarkers();
        }
      } catch (error) {}
    }

    document.addEventListener('message', handleRNMessage);
    window.addEventListener('message', handleRNMessage);

    map.on('move', updateMarkers);
    map.on('moveend', updateMarkers);
    map.on('zoomend', updateMarkers);
    map.whenReady(updateMarkers);
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function AppHeader({ session, onLogout, menuActions = [], onBusQrScanned = null, walletBalance = null, onWalletPress = null }) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logoZoomOpen, setLogoZoomOpen] = useState(false);
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
      const createdAt = booking?.createdAt || 'N/A';
      const ticketID = booking?._id || 'N/A';

      Alert.alert(
        'Ticket verified successfully',
        `Ticket ID: ${ticketID}\nFrom: ${fromStop}\nTo: ${toStop}\nFare: ₹20.0\nPaid Status: ${paidStatus}\nTimestamp: ${createdAt}`
      );
    } catch (error) {
      // If verification failed (already verified / outside window / not found), show alert
      console.log(error.message);
      if (error.message.includes('already')) {
        Alert.alert('Ticket already verified');
      } else {
        Alert.alert('Verification failed', error.message);
      }
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
          <Pressable onPress={() => setLogoZoomOpen(true)} style={styles.headerBrand}>
            <Image source={require('./assets/appLogo.png')} style={styles.headerBrandLogo} />
            <View>
              <Text style={styles.headerBrandTitle}>BusIQ</Text>
              <Text style={styles.headerBrandSubtitle}>Making every ride Intelligent</Text>
            </View>
          </Pressable>
        )}
        <View style={styles.headerRight}>
          {session ? (
            <>
              {(session.user.role === 'user') ? (
                <>
                  {walletBalance !== null && onWalletPress ? (
                    <Pressable style={styles.walletGhostIcon} onPress={onWalletPress}>
                      <View style={styles.walletIconContainer}>
                        <Text style={styles.walletIconText}>₹</Text>
                        <Text style={styles.walletBalanceText}>{walletBalance}</Text>
                      </View>
                    </Pressable>
                  ) : null}
                  <Pressable style={styles.ghostIcon} onPress={() => setScannerOpen(true)}>
                    <Image source={require('./assets/qr-code-scan.png')} style={styles.ghostIconImage} />
                  </Pressable>
                </>
              ) : (session.user.role === 'conductor') ?
                (
                  <Pressable style={styles.ghostIcon} onPress={() => setScannerOpen(true)}>
                    <Image source={require('./assets/qr-code-scan.png')} style={styles.ghostIconImage} />
                  </Pressable>
                )
                : null}

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
                  <Pressable style={({ pressed }) => [styles.drawerItem, pressed && styles.drawerItemPressed]} onPress={() => { setMenuOpen(false); setScannerOpen(true); }}>
                    <Text style={styles.drawerItemText}>Scan QR</Text>
                  </Pressable>
                  <Pressable style={({ pressed }) => [styles.drawerItem, pressed && styles.drawerItemPressed]} onPress={() => { setMenuOpen(false); onLogout(); }}>
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

      <Modal visible={logoZoomOpen} transparent animationType="fade" onRequestClose={() => setLogoZoomOpen(false)}>
        <Pressable style={styles.logoZoomBackdrop} onPress={() => setLogoZoomOpen(false)}>
          <View style={styles.logoZoomContainer}>
            <Image source={require('./assets/appLogo.png')} style={styles.logoZoomImage} />
          </View>
        </Pressable>
      </Modal>
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
    <Pressable onPress={onPress} style={({ pressed }) => [styles.pill, active && styles.pillActive, pressed && styles.pillPressed]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function DotLoading() {
  const dotAnimations = useRef([...Array(5)].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const animations = dotAnimations.map((anim, index) => {
      return Animated.sequence([
        Animated.delay(index * 150),
        Animated.timing(anim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]);
    });

    const loop = Animated.loop(Animated.parallel(animations));
    loop.start();

    return () => loop.stop();
  }, []);

  return (
    <View style={styles.dotLoadingContainer}>
      {dotAnimations.map((anim, index) => (
        <Animated.View
          key={index}
          style={[
            styles.dot,
            {
              opacity: anim,
              transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
            },
          ]}
        />
      ))}
    </View>
  );
}

function PrimaryButton({ label, onPress, loading = false, disabled = false, style }) {
  const isDisabled = loading || disabled;
  return (
    <Pressable onPress={onPress} disabled={isDisabled} style={({ pressed }) => [styles.primaryButton, isDisabled && styles.primaryButtonDisabled, style, pressed && !isDisabled && styles.primaryButtonPressed]}>
      {loading ? <DotLoading /> : <Text style={styles.primaryButtonText}>{label}</Text>}
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
  const [zoom, setZoom] = useState(0);

  useEffect(() => {
    setLocked(false);
    setZoom(0);
  }, [purpose]);

  const handleBarcodeScanned = async ({ data }) => {
    if (locked) {
      return;
    }

    // Auto-zoom in when QR is detected
    setZoom(0.3);

    const parsed = parseQrData(data);
    if (!parsed) {
      Alert.alert('Invalid QR', 'This QR code is not recognized by the app.');
      setZoom(0);
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
      // Delay before unlocking to avoid duplicate rapid scans
      setTimeout(() => {
        setLocked(false);
        setZoom(0);
      }, 1500);
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
                  zoom={zoom}
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
      <View style={styles.busEtaRow}>
        <Text style={styles.busEtaText}>📍 View ticket for estimated arrival time</Text>
      </View>
      {!hideActions && onStartBooking ? (
        <PrimaryButton label="Book this bus" onPress={onStartBooking} style={styles.busActionButton} />
      ) : null}
    </Card>
  );
}

function RouteAssistantLauncher({ session }) {
  const [open, setOpen] = useState(false);
  const [userQuery, setUserQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [routeResult, setRouteResult] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [allBuses, setAllBuses] = useState([]);

  useEffect(() => {
    if (open) {
      setRouteError('');
      loadAllBuses();
    }
  }, [open]);

  const loadAllBuses = async () => {
    try {
      const data = await requestJson('/buses', { token: session.token });
      setAllBuses(data.buses || []);
    } catch (error) {
      console.error('Failed to load buses:', error);
      setAllBuses([]);
    }
  };

  const analyzeRouteWithGemini = async () => {
    const query = String(userQuery || '').trim();

    if (!query) {
      setRouteError('Please enter your travel request.');
      setRouteResult(null);
      return;
    }

    if (!allBuses.length) {
      setRouteError('No buses available for analysis.');
      setRouteResult(null);
      return;
    }

    try {
      setLoading(true);
      setRouteError('');

      // Prepare bus data for Gemini
      const busData = allBuses.map(bus => {
        const routeStops = getBusRouteStops(bus);
        return {
          busNumber: bus.busNumber,
          from: bus.from,
          to: bus.to,
          stops: routeStops,
          startTime: bus.startTime,
          endTime: bus.endTime,
        };
      });

      const systemPrompt = `You are a bus route assistant. Analyze the available buses and their stops to find the best route for the user's request.
The user will ask in natural language like "I need to go from stop A to stop Z".
Your task is to:
1. Identify the start and end stops from the user's request
2. Find direct buses if available
3. If no direct bus, find multi-bus routes with transfer points
4. Analyze general or current typical traffic conditions between these locations using your general knowledge (outside traffic data), and determine the best and worst routes based on traffic.
5. Return the result in JSON format with this structure:
{
  "found": true/false,
  "summary": "Brief description of the best route and why it's recommended.",
  "traffic_analysis": {
    "best_route_reasoning": "Why this route is best considering traffic",
    "worst_route_reasoning": "What route to avoid due to typical traffic"
  },
  "transfers": number of transfers,
  "segments": [
    {
      "busNumber": "BUS-101",
      "busId": "bus_id",
      "routeStops": ["Stop A", "Stop B", "Stop C"],
      "fromStop": "Stop A",
      "toStop": "Stop C"
    }
  ]
}

If no route is found, return:
{
  "found": false,
  "message": "Reason why no route was found"
}`;

      const userPrompt = `Available buses with their stops:
${JSON.stringify(busData, null, 2)}

User request: "${query}"

Find the best bus route and return the result in the specified JSON format.`;

      // Call Gemini API
      const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.EXPO_PUBLIC_GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            { role: 'user', parts: [{ text: userPrompt }] }
          ],
          generationConfig: {
            temperature: 0.7,
            response_mime_type: "application/json",
          },
        }),
      });

      if (!geminiResponse.ok) {
        const errorData = await geminiResponse.text();
        throw new Error(`Gemini API error: ${errorData}`);
      }

      const geminiData = await geminiResponse.json();
      const aiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!aiContent) {
        throw new Error('No response from Gemini');
      }

      const parsedResult = JSON.parse(aiContent);
      setRouteResult(parsedResult);
    } catch (error) {
      console.error('Gemini analysis error:', error);
      setRouteResult(null);
      setRouteError(error.message || 'Failed to analyze route with AI');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {session ? (
        <>
          {(session.user.role === 'user') ? (
            <Pressable style={styles.aiLauncherButton} onPress={() => setOpen(true)}>
              <Text style={styles.aiLauncherButtonText}>AI</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.aiModalBackdrop}>
          <KeyboardAvoidingView style={styles.aiModalShell} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.aiModalCard}>
              <View style={styles.aiModalHeader}>
                <View style={styles.aiModalHeaderText}>
                  <Text style={styles.kicker}>AI Route Assistant</Text>
                  <Text style={styles.aiModalTitle}>Find the bus chain</Text>
                  <Text style={styles.aiModalSubtitle}>Enter the from and to cities. I’ll search the stored buses and transfer stops.</Text>
                </View>
                <Pressable onPress={() => setOpen(false)} style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>Close</Text>
                </Pressable>
              </View>

              <ScrollView contentContainerStyle={styles.aiModalContent} showsVerticalScrollIndicator={false}>
                <Field label="Where do you want to go?" value={userQuery} onChangeText={setUserQuery} placeholder="I need to go from Stop A to Stop Z" multiline numberOfLines={3} />

                <PrimaryButton label="Find route with AI" onPress={analyzeRouteWithGemini} loading={loading} />

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
                    {routeResult.traffic_analysis ? (
                      <View style={{ marginTop: 12, padding: 12, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' }}>
                        <Text style={{ fontWeight: '600', marginBottom: 4, color: '#0f172a' }}>🚦 Traffic Analysis</Text>
                        <Text style={{ fontSize: 13, color: '#16a34a', marginBottom: 4 }}>✓ <Text style={{ fontWeight: '600' }}>Best route:</Text> {routeResult.traffic_analysis.best_route_reasoning}</Text>
                        <Text style={{ fontSize: 13, color: '#dc2626' }}>✗ <Text style={{ fontWeight: '600' }}>Worst route:</Text> {routeResult.traffic_analysis.worst_route_reasoning}</Text>
                      </View>
                    ) : null}
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
            <Pressable style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]} onPress={onClose}>
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
                <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValueSmall}>-</Text></View>
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
  const [userLocation, setUserLocation] = useState(null);
  const [proximityNotified, setProximityNotified] = useState(false);

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

  useEffect(() => {
    let isActive = true;

    const loadUserLocation = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          return;
        }

        const location = await Location.getCurrentPositionAsync({});
        if (isActive) {
          setUserLocation({
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          });
        }
      } catch (error) {
        console.error('Error getting user location:', error);
      }
    };

    loadUserLocation();
    const locationIntervalId = setInterval(loadUserLocation, 10000);

    return () => {
      isActive = false;
      clearInterval(locationIntervalId);
    };
  }, []);

  useEffect(() => {
    if (!locationData || !ticket?.bus?.stops || proximityNotified) {
      return;
    }

    const endStop = ticket.endStop;
    const stops = ticket.bus.stops || [];
    const endStopIndex = stops.findIndex((stop) => stop.name === endStop);

    if (endStopIndex <= 0) {
      return;
    }

    const previousStop = stops[endStopIndex - 1];
    if (!previousStop) {
      return;
    }

    const distanceToPreviousStop = calculateDistance(
      locationData.latitude,
      locationData.longitude,
      previousStop.lat,
      previousStop.lng
    );

    if (distanceToPreviousStop < 0.5) {
      setProximityNotified(true);
      try {
        Vibration.vibrate([200, 100, 200]);
      } catch (e) {
        console.log('Vibration failed', e);
      }
      Alert.alert(
        'Approaching your stop',
        `The bus is about to reach ${previousStop.name}. Get ready to alight at ${endStop}.`
      );
    }
  }, [locationData, ticket, proximityNotified]);

  const mapUrl = useMemo(() => buildMapEmbedUrl(locationData?.latitude, locationData?.longitude, userLocation?.latitude, userLocation?.longitude), [locationData, userLocation]);

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={styles.trackingModalScreen}>
        <View style={styles.trackingModalHeader}>
          <View>
            <View style={styles.trackingHeaderRow}>
              <Text style={styles.kicker}>Live tracking</Text>
              <Pressable onPress={onClose} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText2}>Back</Text>
              </Pressable>
            </View>
            <Text style={styles.trackingTitle}>Bus {ticket?.bus?.busNumber || ticket?.busNumber || 'Ticket'}</Text>
            <Text style={styles.trackingSubtitle}>Updates every 5 seconds from the tracking endpoint.</Text>
          </View>
        </View>

        <Card style={styles.trackingCard}>
          {busMatches ? (
            <>
              <View style={styles.trackingMapWrap}>
                {locationData ? (
                  Platform.OS === 'web' ? (
                    <View style={styles.trackingIframeWrap}>
                      <iframe
                        title="Live bus location map"
                        src={mapUrl}
                        style={styles.trackingIframe}
                        loading="lazy"
                      />
                    </View>
                  ) : (
                    <WebView
                      source={{ uri: mapUrl }}
                      style={styles.trackingMapView}
                      javaScriptEnabled={true}
                      domStorageEnabled={true}
                      startInLoadingState={true}
                      scalesPageToFit={true}
                    />
                  )
                ) : (
                  <View style={styles.trackingMapFallback}>
                    <Text style={styles.helperText}>Waiting for location data...</Text>
                  </View>
                )}
                <View style={styles.trackingMapOverlay}>
                  <Text style={styles.trackingOverlayLabel}>{locationData?.busNumber || ticket?.bus?.busNumber || 'Live bus'}</Text>
                  <Text style={styles.trackingOverlayValue}>{locationData?.timeStamp || 'Fetching live position...'}</Text>
                  {userLocation ? (
                    <View style={styles.userLocationIndicator}>
                      <View style={styles.userLocationDot} />
                      <Text style={styles.userLocationText}>Your location</Text>
                    </View>
                  ) : null}
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
  const [selectedRegisterChoice, setSelectedRegisterChoice] = useState(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();

    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(20);

    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();
  }, [mode]);

  useEffect(() => {
    scaleAnim.setValue(0.98);
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 8,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [selectedLoginChoice, selectedRegisterChoice]);

  const submit = async () => {
    try {
      if (mode === 'login' && !selectedLoginChoice) {
        Alert.alert('Select login type', 'Please select either User login or Admin login before continuing.');
        return;
      }

      if (mode === 'register' && !selectedRegisterChoice) {
        Alert.alert('Select role', 'Please select either User or Conductor before continuing.');
        return;
      }

      setLoading(true);
      const payload = {
        email: form.email.trim(),
        password: form.password,
      };

      if (mode === 'register') {
        payload.name = form.name.trim();
        payload.role = selectedRegisterChoice;
      }

      const data = await requestJson(`/auth/${mode}`, {
        method: 'POST',
        body: payload,
      });

      await AsyncStorage.setItem('session', JSON.stringify(data));
      onAuthed(data);
    } catch (error) {
      Alert.alert('Authentication failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoginChoicePress = (choice) => {
    if (selectedLoginChoice === choice) {
      setSelectedLoginChoice(null);
    } else {
      setSelectedLoginChoice(choice);
    }
  };

  const handleRegisterChoicePress = (choice) => {
    if (selectedRegisterChoice === choice) {
      setSelectedRegisterChoice(null);
    } else {
      setSelectedRegisterChoice(choice);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.scrollContent, styles.authScrollContent]}>
      <View style={styles.authScreenLayout}>
        <View style={styles.authScreenTop}>
          <Animated.View style={[styles.authCard, { opacity: fadeAnim, transform: [{ translateY: slideAnim }, { scale: scaleAnim }] }]}>
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
              <PrimaryButton label={mode === 'login' ? 'Login' : 'Register'} onPress={submit} loading={loading} />
            </Card>
          </Animated.View>

        </View>

        {mode === 'login' ? (
          <View style={styles.loginChoiceDock}>
            <Pressable onPress={() => handleLoginChoicePress('user')} style={[styles.loginChoiceButton, selectedLoginChoice === 'user' && styles.loginChoiceButtonActive, selectedLoginChoice === 'admin' && styles.loginChoiceButtonHidden]}>
              <Text style={[styles.loginChoiceButtonText, selectedLoginChoice === 'user' && styles.loginChoiceButtonTextActive]}>Passenger login</Text>
            </Pressable>
            <Pressable onPress={() => handleLoginChoicePress('admin')} style={[styles.loginChoiceButton, selectedLoginChoice === 'admin' && styles.loginChoiceButtonActive, selectedLoginChoice === 'user' && styles.loginChoiceButtonHidden]}>
              <Text style={[styles.loginChoiceButtonText, selectedLoginChoice === 'admin' && styles.loginChoiceButtonTextActive]}>Conductor login</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.loginChoiceDock}>
            <Pressable onPress={() => handleRegisterChoicePress('user')} style={[styles.loginChoiceButton, selectedRegisterChoice === 'user' && styles.loginChoiceButtonActive, selectedRegisterChoice === 'conductor' && styles.loginChoiceButtonHidden]}>
              <Text style={[styles.loginChoiceButtonText, selectedRegisterChoice === 'user' && styles.loginChoiceButtonTextActive]}>Passenger</Text>
            </Pressable>
            <Pressable onPress={() => handleRegisterChoicePress('conductor')} style={[styles.loginChoiceButton, selectedRegisterChoice === 'conductor' && styles.loginChoiceButtonActive, selectedRegisterChoice === 'user' && styles.loginChoiceButtonHidden]}>
              <Text style={[styles.loginChoiceButtonText, selectedRegisterChoice === 'conductor' && styles.loginChoiceButtonTextActive]}>Conductor</Text>
            </Pressable>
          </View>
        )}
      </View>

    </ScrollView>
  );
}

function UserDashboard({ session, onLogout, refreshSignal, trackingUrl, scannedBusData, onScannedBusDataHandled }) {
  const [activeTab, setActiveTab] = useState('search');
  const [searchValue, setSearchValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [previewBus, setPreviewBus] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [bookingForm, setBookingForm] = useState(bookingInitialState);
  const [scannedStopPickerOpen, setScannedStopPickerOpen] = useState(false);
  const [scannedStopSelection, setScannedStopSelection] = useState({ from: '', to: '' });
  const [stopPickerOpen, setStopPickerOpen] = useState(false);
  const [stopPickerType, setStopPickerType] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [showOnlyCurrentBooked, setShowOnlyCurrentBooked] = useState(false);
  const [qrZoomOpen, setQrZoomOpen] = useState(false);
  const [zoomedQrData, setZoomedQrData] = useState(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletBalance, setWalletBalance] = useState(200);

  const displayedTickets = useMemo(() => {
    if (showOnlyCurrentBooked && selectedTicketId) {
      return tickets.filter((t) => t._id === selectedTicketId || t.id === selectedTicketId);
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
  const [bookingMode, setBookingMode] = useState(false);
  const [showPaymentOptions, setShowPaymentOptions] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [ticketArrivalEstimate, setTicketArrivalEstimate] = useState({ value: '—', note: 'Available during validity only' });
  const [searchTrackingPoint, setSearchTrackingPoint] = useState(null);
  const [paidStatus, setPaidStatus] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [mapUrl, setMapUrl] = useState(null);
  const [liveMapUrl, setLiveMapUrl] = useState(null);
  const [liveMapBuses, setLiveMapBuses] = useState([]);
  const [nearbyBuses, setNearbyBuses] = useState([]);
  const [locating, setLocating] = useState(false);
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [locationFetched, setLocationFetched] = useState(false);
  const liveMapWebViewRef = useRef(null);

  const scannedRouteStops = useMemo(() => getBusRouteStops(previewBus), [previewBus]);

  const getCurrentLocation = async () => {
    try {
      setLocating(true);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Location permission is required to show your current location.');
        return;
      }
      const location = await Location.getCurrentPositionAsync({});
      const { latitude, longitude } = location.coords;
      setUserLocation({ latitude, longitude });
      setMapUrl(buildSimpleMapUrl(latitude, longitude));
      setLocationFetched(true);
    } catch (error) {
      Alert.alert('Location error', 'Unable to get your current location.');
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    getCurrentLocation();
  }, []);

  const fetchLiveMapBuses = async () => {
    try {
      const data = await requestJson('/buses', { token: session.token });
      const buses = (data.buses || []).filter((bus) => bus.isVisible !== false);
      setLiveMapBuses(buses);
      return buses;
    } catch (error) {
      console.log('Failed to load live map buses', error);
      return liveMapBuses;
    }
  };

  const refreshLiveMap = async (location = userLocation) => {
    const buses = await fetchLiveMapBuses();
    if (location?.latitude && location?.longitude) {
      setLiveMapUrl(buildLiveBusesMapUrl(location.latitude, location.longitude, buses));
    }
    return buses;
  };

  const pushBusesToLiveMap = (buses) => {
    const payload = getBusesWithCurrentLocation(buses).map((bus) => ({
      id: String(bus._id),
      busNumber: String(bus.busNumber || ''),
      lat: Number(bus.currentLocation.lat),
      lng: Number(bus.currentLocation.lng),
    }));

    liveMapWebViewRef.current?.postMessage(JSON.stringify({ type: 'updateBuses', buses: payload }));
  };

  const handleMapPress = async () => {
    setNearbyBuses([]);

    let location = userLocation;
    if (!locationFetched || !location) {
      try {
        setLocating(true);
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission denied', 'Location permission is required to show buses around you.');
          return;
        }
        const current = await Location.getCurrentPositionAsync({});
        location = { latitude: current.coords.latitude, longitude: current.coords.longitude };
        setUserLocation(location);
        setMapUrl(buildSimpleMapUrl(location.latitude, location.longitude));
        setLocationFetched(true);
      } catch (error) {
        Alert.alert('Location error', 'Unable to get your current location.');
        return;
      } finally {
        setLocating(false);
      }
    }

    if (!location) {
      return;
    }

    setMapModalOpen(true);
    await refreshLiveMap(location);
  };

  const closeMapModal = () => {
    setMapModalOpen(false);
    setNearbyBuses([]);
  };

  const recenterLiveMap = () => {
    if (!userLocation) {
      getCurrentLocation();
      return;
    }

    liveMapWebViewRef.current?.postMessage(JSON.stringify({
      type: 'recenter',
      lat: userLocation.latitude,
      lng: userLocation.longitude,
    }));
  };

  const handleLiveMapMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'visibleBuses') {
        const visible = (data.buses || [])
          .map((entry) => liveMapBuses.find((bus) => String(bus._id) === entry.id))
          .filter(Boolean);
        setNearbyBuses(visible);
        return;
      }

      if (data.type === 'busTapped') {
        const bus = liveMapBuses.find((item) => String(item._id) === data.busId);
        if (bus) {
          closeMapModal();
          openScannedBusStopSelector(bus);
        }
      }
    } catch (error) {
      console.log('Live map message error', error);
    }
  };

  useEffect(() => {
    if (!mapModalOpen) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      fetchLiveMapBuses();
    }, 8000);

    return () => clearInterval(intervalId);
  }, [mapModalOpen, session.token]);

  useEffect(() => {
    if (!mapModalOpen || !liveMapBuses.length) {
      return;
    }

    pushBusesToLiveMap(liveMapBuses);
  }, [liveMapBuses, mapModalOpen]);
  const scannedFromIndex = routeStopIndex(scannedRouteStops, scannedStopSelection.from);
  const scannedToIndex = routeStopIndex(scannedRouteStops, scannedStopSelection.to);
  const canContinueScannedBooking = Boolean(
    previewBus
    && scannedStopSelection.from
    && scannedStopSelection.to
    && scannedFromIndex >= 0
    && scannedToIndex > scannedFromIndex
  );

  useEffect(() => {
    const intervalId = setInterval(() => {
      setCurrentTime(new Date());
    }, 30000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const onBackPress = () => {
      if (activeTab === 'ticket' && showOnlyCurrentBooked) {
        setShowOnlyCurrentBooked(false);
        setActiveTab('search');
        return true;
      }

      return false;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [activeTab, showOnlyCurrentBooked]);

  useEffect(() => {
    let isActive = true;
    let intervalId = null;

    const loadSearchTracking = async () => {
      if (!trackingUrl || activeTab !== 'search') {
        return;
      }

      try {
        const data = await fetchTrackingLocation(trackingUrl);

        if (!isActive) {
          return;
        }

        setSearchTrackingPoint({
          busNumber: normalizeBusNumber(data?.busNumber),
          latitude: Number(data?.latitude),
          longitude: Number(data?.longitude),
        });
      } catch (error) {
        if (isActive) {
          setSearchTrackingPoint(null);
        }
      }
    };

    loadSearchTracking();

    if (trackingUrl && activeTab === 'search') {
      intervalId = setInterval(loadSearchTracking, 5000);
    }

    return () => {
      isActive = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [activeTab, trackingUrl]);

  const getSearchBusEta = (bus) => {
    if (!searchTrackingPoint || !searchTrackingPoint.busNumber) {
      return 'ETA: waiting for live bus';
    }

    const busNumber = normalizeBusNumber(bus?.busNumber);
    if (!busNumber || busNumber !== searchTrackingPoint.busNumber) {
      return 'ETA: waiting for this bus live signal';
    }

    const routeStops = Array.isArray(bus?.stops) ? bus.stops : [];
    const targetStop = routeStops.find((stop) => Number.isFinite(Number(stop?.lat)) && Number.isFinite(Number(stop?.lng)));

    if (!targetStop) {
      return 'ETA: stop location unavailable';
    }

    const distanceKm = calculateDistance(
      Number(searchTrackingPoint.latitude),
      Number(searchTrackingPoint.longitude),
      Number(targetStop.lat),
      Number(targetStop.lng)
    );

    const etaValue = formatArrivalEstimate(distanceKm);
    return etaValue ? `ETA: ${etaValue}` : 'ETA: unavailable';
  };

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

  useEffect(() => {
    if (scannedBusData) {
      handleBusScan(scannedBusData, `bus:${scannedBusData.id}`);
      onScannedBusDataHandled();
    }
  }, [scannedBusData]);

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
    setScannedStopPickerOpen(false);
    setScannedStopSelection({ from: '', to: '' });
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
    setBookingMode(false);
    setShowPaymentOptions(false);
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
    const requestedStartStop = String(fromSelection || routeStops[0] || '').trim();
    const requestedEndStop = String(toSelection || routeStops[routeStops.length - 1] || '').trim();
    let startStop = requestedStartStop;
    let endStop = requestedEndStop;

    if (routeStopIndex(routeStops, startStop) < 0) {
      startStop = String(routeStops[0] || '').trim();
    }

    if (routeStopIndex(routeStops, endStop) < 0) {
      endStop = String(routeStops[routeStops.length - 1] || '').trim();
    }

    const startIndex = routeStopIndex(routeStops, startStop);
    const endIndex = routeStopIndex(routeStops, endStop);
    if (startIndex >= 0 && (endIndex < 0 || endIndex <= startIndex)) {
      const fallbackEnd = routeStops[Math.min(routeStops.length - 1, startIndex + 1)] || routeStops[routeStops.length - 1] || '';
      endStop = String(fallbackEnd).trim();
    }

    setSelectedBus(bus);
    setScanBookingBusId(null);
    setScannedStopPickerOpen(false);
    setScannedStopSelection({ from: '', to: '' });
    // Don't clear searchResults to preserve them when going back
    // setSearchResults([]);
    setPreviewBus(null);
    setBookingForm((current) => ({
      ...current,
      timingLabel: bus.timings?.[0]?.label || humanTimeRange(bus.startTime, bus.endTime),
      startStop,
      endStop,
      seats: current.seats || '1',
    }));
    setActiveTab('search');
    setShowOnlyCurrentBooked(false);
    setBookingMode(true);
    setShowPaymentOptions(false);
  };

  const openBusBookingWithStops = (bus, fromStop, toStop) => {
    if (!bus) {
      return;
    }

    const routeStops = getBusRouteStops(bus);
    const normalizedFrom = String(fromStop || routeStops[0] || '').trim();
    const normalizedTo = String(toStop || routeStops[routeStops.length - 1] || '').trim();
    const fromIdx = routeStopIndex(routeStops, normalizedFrom);
    const toIdx = routeStopIndex(routeStops, normalizedTo);

    if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) {
      Alert.alert('Invalid route', 'Select valid stops in route order.');
      return;
    }

    setFromSelection(normalizedFrom);
    setToSelection(normalizedTo);
    setScannedStopPickerOpen(false);
    setScannedStopSelection({ from: '', to: '' });
    setPreviewBus(null);
    setSelectedBus(bus);
    setScanBookingBusId(null);
    setBookingForm((current) => ({
      ...current,
      timingLabel: bus.timings?.[0]?.label || humanTimeRange(bus.startTime, bus.endTime),
      startStop: normalizedFrom,
      endStop: normalizedTo,
      seats: '1',
    }));
    setActiveTab('search');
    setShowOnlyCurrentBooked(false);
    setBookingMode(true);
    setShowPaymentOptions(false);
  };

  const closeScannedStopPicker = () => {
    setScannedStopPickerOpen(false);
    setScannedStopSelection({ from: '', to: '' });
    setPreviewBus(null);
    setScanBookingBusId(null);
  };

  const handleScannedStopPress = (stopName) => {
    setScannedStopSelection((current) => {
      const selectedStop = String(stopName || '').trim();
      if (!selectedStop) {
        return current;
      }

      if (!current.from || current.to) {
        return { from: selectedStop, to: '' };
      }

      const fromIdx = routeStopIndex(scannedRouteStops, current.from);
      const toIdx = routeStopIndex(scannedRouteStops, selectedStop);

      if (toIdx <= fromIdx) {
        Alert.alert('Choose destination', 'Second tap must be a stop after the selected start stop.');
        return current;
      }

      return { ...current, to: selectedStop };
    });
  };

  const openScannedBusStopSelector = (bus) => {
    if (!bus) {
      return;
    }

    const routeStops = getBusRouteStops(bus);
    if (routeStops.length < 2) {
      Alert.alert('Bus unavailable', 'This bus does not have enough route stops for booking.');
      return;
    }

    setPreviewBus(bus);
    setSelectedBus(null);
    setBookingMode(false);
    setShowPaymentOptions(false);
    setScanBookingBusId(bus._id || bus.id || null);
    setScannedStopSelection({ from: '', to: '' });
    setScannedStopPickerOpen(true);
    setScannerOpen(false);
  };

  const closeBooking = () => {
    setBookingMode(false);
    setSelectedBus(null);
    setBookingForm(bookingInitialState);
    setScannedStopPickerOpen(false);
    setScannedStopSelection({ from: '', to: '' });
    setPreviewBus(null);
    setActiveTab('search');
    setShowOnlyCurrentBooked(false);
    setShowPaymentOptions(false);
    // Keep search results and from/to selections to go back to search results page
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
        openScannedBusStopSelector(embeddedBus);
        setSearchValue(embeddedBus.busNumber || '');
        setScannerOpen(false);
        return;
      }

      const data = await requestJson(`/buses/${parsed?.id}`, { token: session.token });
      if (!data.bus) {
        Alert.alert('Bus unavailable', 'This bus is not available right now.');
        return;
      }

      openScannedBusStopSelector(data.bus || null);
      setSearchValue(data.bus.busNumber || '');
      setScannerOpen(false);
    } catch (error) {
      const isUnavailable = /bus not found|not available/i.test(String(error.message || ''));
      Alert.alert(isUnavailable ? 'Bus unavailable' : 'QR scan failed', isUnavailable ? 'This bus is not available right now.' : error.message);
    } finally {
      setLoading(false);
    }
  };

  const createBooking = async (paidStatusOverride = null) => {
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
          paidStatus: paidStatusOverride !== null ? paidStatusOverride : paidStatus,
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

  const pressedPayButton = async (mode) => {
    const isPaid = mode === "upi" || mode === "wallet";
    setPaidStatus(isPaid);
    createBooking(isPaid);
  }

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

  const isTicketWithinValidity = useMemo(() => {
    if (!selectedTicket) {
      return false;
    }

    const validFrom = new Date(selectedTicket.validFrom);
    const validTo = new Date(selectedTicket.validTo);

    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
      return false;
    }

    return currentTime >= validFrom && currentTime <= validTo;
  }, [selectedTicket, currentTime]);

  const isOtpVisible = useMemo(() => {
    return isTicketWithinValidity;
  }, [isTicketWithinValidity]);

  useEffect(() => {
    let isActive = true;
    let intervalId = null;

    const resetEstimate = (note) => {
      if (isActive) {
        setTicketArrivalEstimate({ value: '—', note });
      }
    };

    const updateEstimate = async () => {
      if (!selectedTicket || !isTicketWithinValidity) {
        resetEstimate('Available during validity only');
        return;
      }

      const ticketBusNumber = normalizeBusNumber(selectedTicket?.bus?.busNumber || selectedTicket?.busNumber);
      const bookedStop = findStopByName(selectedTicket?.bus?.stops, selectedTicket?.startStop);

      if (!trackingUrl) {
        resetEstimate('Live tracking not configured');
        return;
      }

      if (!ticketBusNumber || !bookedStop || !Number.isFinite(Number(bookedStop.lat)) || !Number.isFinite(Number(bookedStop.lng))) {
        resetEstimate('Booked stop location unavailable');
        return;
      }

      try {
        const data = await fetchTrackingLocation(trackingUrl);

        if (!isActive) {
          return;
        }

        const liveBusNumber = normalizeBusNumber(data?.busNumber);
        const busLat = Number(data?.latitude);
        const busLng = Number(data?.longitude);

        if (!liveBusNumber || liveBusNumber !== ticketBusNumber) {
          setTicketArrivalEstimate({ value: '—', note: 'Waiting for matching live bus' });
          return;
        }

        if (!Number.isFinite(busLat) || !Number.isFinite(busLng)) {
          setTicketArrivalEstimate({ value: '—', note: 'Live location unavailable' });
          return;
        }

        const distanceKm = calculateDistance(busLat, busLng, Number(bookedStop.lat), Number(bookedStop.lng));
        const value = formatArrivalEstimate(distanceKm);
        setTicketArrivalEstimate({
          value: value || '—',
          note: value ? `${selectedTicket.startStop} • ${distanceKm.toFixed(1)} km away` : 'Unable to estimate arrival',
        });
      } catch (error) {
        if (isActive) {
          setTicketArrivalEstimate({ value: '—', note: 'Live tracking unavailable' });
        }
      }
    };

    updateEstimate();

    if (selectedTicket && isTicketWithinValidity) {
      intervalId = setInterval(updateEstimate, 5000);
    }

    return () => {
      isActive = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [selectedTicket, trackingUrl, isTicketWithinValidity]);

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
        walletBalance={walletBalance}
        onWalletPress={() => setWalletOpen(true)}
        menuActions={[
          { label: 'Search bus', onPress: () => { setShowOnlyCurrentBooked(false); setActiveTab('search'); setBookingMode(false); } },
          { label: 'Ticket', onPress: () => { setShowOnlyCurrentBooked(false); setActiveTab('ticket'); setSelectedBus(null); } },
          { label: 'Sync tickets', onPress: () => { setShowOnlyCurrentBooked(false); manualSyncTickets(); } },
        ]}
      />

      {activeTab === 'search' ? (
        <>
          <Modal visible={scannedStopPickerOpen} animationType="slide" onRequestClose={closeScannedStopPicker}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <Card>
                <View style={styles.scannedStopsHeaderRow}>
                  <Pressable onPress={closeScannedStopPicker} style={styles.secondaryAction}>
                    <Text style={styles.secondaryActionText}>Back</Text>
                  </Pressable>
                  <View style={{ flex: 1, marginHorizontal: 12 }}>
                    <Text style={styles.scannedStopsBusTitle}>Bus {previewBus?.busNumber || ''}</Text>
                    <Text style={styles.scannedStopsBusSubtitle}>{previewBus?.from || ''} → {previewBus?.to || ''}</Text>
                  </View>
                </View>

                <SectionTitle title="Choose stops" description="Tap once for From stop and tap again for To stop." />

                <View style={styles.scannedStopsSelectionBar}>
                  <Text style={styles.scannedStopsSelectionText}>From: {scannedStopSelection.from || 'Tap a stop'}</Text>
                  <Text style={styles.scannedStopsSelectionText}>To: {scannedStopSelection.to || 'Tap a stop after From'}</Text>
                </View>

                <View style={styles.scannedStopsTimelineWrap}>
                  {scannedRouteStops.map((stopName, index) => {
                    const isFrom = scannedStopSelection.from === stopName;
                    const isTo = scannedStopSelection.to === stopName;
                    const isInRange = scannedFromIndex >= 0 && scannedToIndex > scannedFromIndex && index >= scannedFromIndex && index <= scannedToIndex;

                    return (
                      <Pressable
                        key={`scan-stop-${index}-${stopName}`}
                        style={({ pressed }) => [styles.scannedStopRow, pressed && styles.scannedStopRowPressed]}
                        onPress={() => handleScannedStopPress(stopName)}
                      >
                        <View style={styles.scannedStopRailColumn}>
                          {index !== scannedRouteStops.length - 1 ? (
                            <View style={[styles.scannedStopRailLine, isInRange && styles.scannedStopRailLineActive]} />
                          ) : null}
                          <View style={[styles.scannedStopDot, (isFrom || isTo) && styles.scannedStopDotActive]} />
                        </View>
                        <View style={styles.scannedStopTextWrap}>
                          <Text style={styles.scannedStopName}>{stopName}</Text>
                          {isFrom ? <Text style={styles.scannedStopTag}>From stop</Text> : null}
                          {isTo ? <Text style={styles.scannedStopTag}>To stop</Text> : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={styles.rowButtons}>
                  <Pressable
                    style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]}
                    onPress={() => setScannedStopSelection({ from: '', to: '' })}
                  >
                    <Text style={styles.secondaryActionText}>Reset selection</Text>
                  </Pressable>
                  <PrimaryButton
                    label="Continue to seat booking"
                    onPress={() => openBusBookingWithStops(previewBus, scannedStopSelection.from, scannedStopSelection.to)}
                    disabled={!canContinueScannedBooking}
                    style={styles.flexButton}
                  />
                </View>
              </Card>
            </ScrollView>
          </Modal>

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
                  <Pressable key={item} style={({ pressed }) => [styles.locationItemRow, pressed && styles.locationItemRowPressed]} onPress={() => selectLocation(item)}>
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
                  <Pressable style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]} onPress={() => { setCategorySearch(''); loadBusesByType(category || 'Local'); }}>
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

          {!bookingMode ? (
            <Card>
              <SectionTitle title="Find your route" description="Search by bus number or scan the bus QR to load its stops and schedule." />
              <View style={{ marginBottom: 12 }}>
                <View style={styles.splitRow}>
                  <View style={{ flex: 1, position: 'relative' }}>
                    <Text style={styles.fieldLabel}>From</Text>
                    <Pressable style={({ pressed }) => [styles.dropdownButton, pressed && styles.dropdownButtonPressed]} onPress={() => openLocationPicker('from')}>
                      <Text style={[styles.dropdownButtonText, !fromSelection && styles.dropdownPlaceholder]}>{fromSelection || (loadingLocations ? 'Loading…' : 'Select origin')}</Text>
                    </Pressable>
                    <Text style={[styles.helperText, { marginTop: 6 }]}>{loadingLocations ? 'Loading cities and routes…' : 'Opens a full-screen city and route list.'}</Text>
                  </View>
                  <View style={{ flex: 1, position: 'relative' }}>
                    <Text style={styles.fieldLabel}>To</Text>
                    <Pressable style={({ pressed }) => [styles.dropdownButton, pressed && styles.dropdownButtonPressed]} onPress={() => openLocationPicker('to')}>
                      <Text style={[styles.dropdownButtonText, !toSelection && styles.dropdownPlaceholder]}>{toSelection || (loadingLocations ? 'Loading…' : 'Select destination')}</Text>
                    </Pressable>
                    <Text style={[styles.helperText, { marginTop: 6 }]}>{loadingLocations ? '' : 'Opens a full-screen city and route list.'}</Text>
                  </View>
                </View>

                <View style={[styles.rowButtons, { marginTop: 12 }]}>
                  <PrimaryButton label="Search bus" onPress={() => fetchBus(searchValue)} loading={loading} style={styles.flexButton} />

                </View>
              </View>
              {searchResults.length ? (
                <View>
                  <Text style={styles.helperText}>{searchResults.length} buses found</Text>
                  {searchResults.map((bus) => {
                    const crowd = getBusCrowdPresentation(bus);
                    const searchEta = getSearchBusEta(bus);
                    return (
                      <Pressable key={bus._id} onPress={() => openBusBooking(bus)} style={({ pressed }) => [styles.busSearchResultCard, pressed && styles.busSearchResultCardPressed]}>
                        <View style={styles.busTopRow}>
                          <View>
                            <Text style={styles.busSearchResultTitle}>Bus {bus.busNumber}</Text>
                            <Text style={styles.busSearchResultSeats}>{bus.from} → {bus.to}</Text>
                          </View>
                          <View style={styles.searchResultStatusWrap}>
                            <View style={styles.crowdStatusBadge}>
                              <View style={[styles.crowdStatusDot, { backgroundColor: crowd.color }]} />
                              <Text style={styles.crowdStatusText}>{crowd.label}</Text>
                            </View>
                            {/*<Text style={styles.searchResultEtaText}>{searchEta}</Text>*/}
                            <Text style={styles.searchResultEtaText}>5mins away</Text>
                          </View>
                        </View>
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
          ) : null}

          {!bookingMode && (
            <Card>
              <SectionTitle title="Buses around you" description="Tap the map to search buses near any location." />
              <Pressable onPress={handleMapPress} style={styles.liveMapPreview}>
                {mapUrl ? (
                  <WebView
                    source={{ uri: mapUrl }}
                    style={styles.liveMapPreviewWebView}
                    scrollEnabled={false}
                    pointerEvents="none"
                  />
                ) : (
                  <View style={styles.liveMapPreviewFallback}>
                    {locating ? (
                      <ActivityIndicator size="large" color="#0EA5E9" />
                    ) : (
                      <>
                        <Text style={styles.liveMapPreviewTitle}>Loading location...</Text>
                        <Text style={styles.liveMapPreviewSubtitle}>Please wait while we get your location</Text>
                      </>
                    )}
                  </View>
                )}
                <View style={styles.liveMapPreviewHint} pointerEvents="none">
                  <Text style={styles.liveMapPreviewHintText}>Tap to open live map</Text>
                </View>
              </Pressable>
            </Card>
          )}

          <Modal visible={mapModalOpen} animationType="slide" onRequestClose={closeMapModal}>
            <View style={styles.liveMapModalScreen}>
              <View style={styles.liveMapModalHeader}>
                <Pressable onPress={closeMapModal} style={styles.liveMapBackButton}>
                  <Text style={styles.liveMapBackButtonText}>←</Text>
                </Pressable>
                <Text style={styles.liveMapModalTitle}>Live map</Text>
                <View style={styles.liveMapHeaderSpacer} />
              </View>

              <View style={styles.liveMapStage}>
                {liveMapUrl ? (
                  <WebView
                    ref={liveMapWebViewRef}
                    source={{ uri: liveMapUrl }}
                    style={styles.liveMapWebView}
                    javaScriptEnabled
                    domStorageEnabled
                    onMessage={handleLiveMapMessage}
                    startInLoadingState
                  />
                ) : (
                  <View style={styles.liveMapPreviewFallback}>
                    {locating ? (
                      <ActivityIndicator size="large" color="#0EA5E9" />
                    ) : (
                      <>
                        <Text style={styles.liveMapPreviewTitle}>Loading map...</Text>
                        <Text style={styles.liveMapPreviewSubtitle}>Fetching your location and nearby buses</Text>
                      </>
                    )}
                  </View>
                )}

                <View style={styles.liveMapCircleOverlay} pointerEvents="none">
                  <View
                    style={[
                      styles.liveMapCircle,
                      {
                        width: LIVE_MAP_CIRCLE_RADIUS * 2,
                        height: LIVE_MAP_CIRCLE_RADIUS * 2,
                        borderRadius: LIVE_MAP_CIRCLE_RADIUS,
                      },
                    ]}
                  />
                  <View style={styles.liveMapCenterPinOuter}>
                    <View style={styles.liveMapCenterPinInner} />
                  </View>
                </View>

                <Pressable onPress={recenterLiveMap} style={styles.liveMapLocateButton}>
                  <Text style={styles.liveMapLocateButtonText}>⌖</Text>
                </Pressable>

                {nearbyBuses.length ? (
                  <View style={styles.liveMapNearbyPanel}>
                    <Text style={styles.liveMapNearbyTitle}>{nearbyBuses.length} bus{nearbyBuses.length === 1 ? '' : 'es'} in this area</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.liveMapNearbyList}>
                      {nearbyBuses.map((bus) => (
                        <Pressable
                          key={bus._id}
                          onPress={() => {
                            closeMapModal();
                            openBusBooking(bus);
                          }}
                          style={({ pressed }) => [styles.liveMapNearbyChip, pressed && styles.liveMapNearbyChipPressed]}
                        >
                          <Text style={styles.liveMapNearbyChipText}>🚌 {bus.busNumber}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                ) : liveMapUrl ? (
                  <View style={styles.liveMapNearbyPanel}>
                    <Text style={styles.liveMapNearbyEmpty}>Move the map to search buses in this area</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </Modal>
        </>
      ) : null}

      {selectedBus && bookingMode ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Pressable onPress={closeBooking} style={styles.secondaryAction}>
              <Text style={styles.secondaryActionText}>← Back</Text>
            </Pressable>
            <Text style={[styles.cardSubtitle, { marginLeft: 12 }]}>Bus {selectedBus.busNumber}</Text>
          </View>
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
              <Pressable style={({ pressed }) => [styles.dropdownButton, pressed && styles.dropdownButtonPressed]} onPress={() => { setStopPickerType('start'); setStopPickerOpen(true); }}>
                <Text style={[styles.dropdownButtonText, !selectedStartStop && styles.dropdownPlaceholder]}>
                  {selectedStartStop || 'Select start stop'}
                </Text>
              </Pressable>
            </View>
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>End stop</Text>
              <Pressable style={({ pressed }) => [styles.dropdownButton, pressed && styles.dropdownButtonPressed]} onPress={() => { setStopPickerType('end'); setStopPickerOpen(true); }}>
                <Text style={[styles.dropdownButtonText, !selectedEndStop && styles.dropdownPlaceholder]}>
                  {selectedEndStop || 'Select end stop'}
                </Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.paymentDivider} />
          <View style={styles.paymentButtonsContainer}>
            {!showPaymentOptions ? (
              <PrimaryButton label="Pay Rs.40 now" onPress={() => setShowPaymentOptions(true)} />
            ) : (
              <View style={styles.paymentButtonsVertical}>
                <Pressable style={({ pressed }) => [styles.paymentButton, pressed && styles.paymentButtonPressed]} onPress={() => { pressedPayButton("upi") }}>
                  <Text style={styles.paymentButtonText}>Pay using UPI</Text>
                </Pressable>
                <Pressable style={({ pressed }) => [styles.paymentButton, pressed && styles.paymentButtonPressed]} onPress={() => { pressedPayButton("wallet") }}>
                  <Text style={styles.paymentButtonText}>Pay using wallet</Text>
                </Pressable>
                <PrimaryButton label="Pay offline" onPress={() => pressedPayButton("offline")} loading={loading} />
              </View>
            )}
          </View>
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
                  style={({ pressed }) => [styles.assignListItem, pressed && styles.assignListItemPressed]}
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
          <View style={styles.ticketHeaderWithBack}>
            {showOnlyCurrentBooked && (
              <Pressable onPress={() => { setActiveTab('search'); setShowOnlyCurrentBooked(false); }} style={styles.backButtonContainer}>
                <Text style={styles.backButtonText}>← Back to search</Text>
              </Pressable>
            )}
            <SectionTitle title="Your tickets" description="All booked tickets are listed here. Select one to show QR and OTP." />
          </View>
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
                        <Pressable style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]} onPress={() => setSelectedTicketId(ticketItem._id)}>
                          <Text style={styles.secondaryActionText}>{isSelected ? 'Selected' : 'View ticket'}</Text>
                        </Pressable>
                        <Pressable style={({ pressed }) => [styles.liveTrackingButton, pressed && styles.liveTrackingButtonPressed]} onPress={() => openLiveTracking(ticketItem)}>
                          <Text style={styles.liveTrackingButtonText}>Live tracking</Text>
                        </Pressable>
                      </View>
                      {isSelected && selectedTicket ? (
                        <>
                          <View style={styles.ticketMetaGrid}>
                            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Booking</Text><Text style={styles.ticketMetaValue}>#{selectedTicket._id.slice(-8)}</Text></View>
                            {isOtpVisible ? (
                              <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValue}>{selectedTicket.otp}</Text></View>
                            ) : (
                              <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>OTP</Text><Text style={styles.ticketMetaValueSmall}>-</Text></View>
                            )}
                            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel1}>Status</Text><Text style={styles.ticketMetaValue}>{selectedTicket.status}</Text></View>
                            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Timing</Text><Text style={styles.ticketMetaValueSmall}>{ticketTiming || 'n/a'}</Text></View>
                            <View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>Validity</Text><Text style={styles.ticketMetaValueSmall}>{ticketValidity}</Text></View>
                            {/*<View style={styles.ticketMetaBox}><Text style={styles.infoLabel1}>ETA</Text><Text style={styles.ticketMetaValue}>Arrives in 5mins</Text></View>*/}
                            {/*<View style={styles.ticketMetaBox}><Text style={styles.infoLabel}>From stop ETA</Text><Text style={styles.ticketMetaValue}>{ticketArrivalEstimate.value}</Text><Text style={styles.ticketMetaValueSmall}>{ticketArrivalEstimate.note}</Text></View>*/}
                          </View>
                          <PrimaryButton label="Refresh status" onPress={refreshSelectedTicket} loading={refreshingTicket} />
                          {selectedTicket.qrDataUrl ? (
                            <Pressable onPress={() => { setZoomedQrData(selectedTicket.qrDataUrl); setQrZoomOpen(true); }} style={({ pressed }) => pressed && styles.qrImagePressed}>
                              <Image source={{ uri: selectedTicket.qrDataUrl }} style={styles.ticketQrImage} />
                              <Text style={styles.helperText}>Tap to zoom</Text>
                            </Pressable>
                          ) : null}
                          <Text style={styles.helperText}>Route: {selectedTicket.startStop} to {selectedTicket.endStop} • Seats: {selectedTicket.seats}</Text>
                        </>
                      ) : null}
                    </View>
                  );
                })}
              </View>
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

      {qrZoomOpen ? (
        <Modal visible animationType="fade" transparent onRequestClose={() => setQrZoomOpen(false)}>
          <Pressable style={styles.zoomBackdrop} onPress={() => setQrZoomOpen(false)}>
            <View style={styles.zoomContent}>
              <Image source={{ uri: zoomedQrData }} style={{ width: 300, height: 300 }} />
              <Text style={styles.helperText}>Tap outside to close</Text>
            </View>
          </Pressable>
        </Modal>
      ) : null}

      {walletOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setWalletOpen(false)}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Card>
              <View style={styles.scannedStopsHeaderRow}>
                <Pressable onPress={() => setWalletOpen(false)} style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>Back</Text>
                </Pressable>
                <View style={{ flex: 1, marginHorizontal: 12 }}>
                  <Text style={styles.scannedStopsBusTitle}>Wallet</Text>
                  <Text style={styles.scannedStopsBusSubtitle}>Your Balance</Text>
                </View>
              </View>

              <View style={{ marginTop: 32, alignItems: 'center' }}>
                <View style={styles.walletBalanceCard}>
                  <Text style={styles.walletBalanceLabel}>Balance</Text>
                  <Text style={styles.walletBalanceAmount}>₹ {walletBalance}</Text>
                </View>
              </View>
            </Card>
          </ScrollView>
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
  const [verificationFlash, setVerificationFlash] = useState(null);
  const [otpVerify, setOtpVerify] = useState('');
  const [menuOpenBusId, setMenuOpenBusId] = useState(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const scrollViewRef = useRef(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [selectedBusForAnalytics, setSelectedBusForAnalytics] = useState(null);
  const [busAnalyticsSearch, setBusAnalyticsSearch] = useState('');
  const [analytics, setAnalytics] = useState({ todayTrips: 0, ticketCount: 0, revenue: 0 });
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [qrZoomOpen, setQrZoomOpen] = useState(false);
  const [zoomedQrBus, setZoomedQrBus] = useState(null);

  const showVerificationFeedback = (title, message) => {
    setVerificationFlash({ title, message });
    Alert.alert(title, message);
  };

  const onRefresh = () => {
    setRefreshing(true);
    // Reset to add-new mode (stop editing)
    setForm({
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
    });
    setSavedBus(null);
    setActiveTab('add');
    // reload buses as well
    refreshBuses().finally(() => {
      setRefreshing(false);
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    });
  };

  useEffect(() => {
    if (!verificationFlash) {
      return undefined;
    }

    const timer = setTimeout(() => setVerificationFlash(null), 1500);
    return () => clearTimeout(timer);
  }, [verificationFlash]);
  const [trackingInput, setTrackingInput] = useState(trackingUrl || '');
  const [trackingSaving, setTrackingSaving] = useState(false);
  const [trackingMessage, setTrackingMessage] = useState('');
  const [trackingModalOpen, setTrackingModalOpen] = useState(false);

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

  const fetchBusAnalytics = async (busId) => {
    if (!busId) return;
    try {
      setAnalyticsLoading(true);
      const data = await requestJson(`/analytics/bus/${busId}`, { token: session.token });
      setAnalytics({
        todayTrips: data.todayTrips || 0,
        ticketCount: data.ticketCount || 0,
        revenue: data.revenue || 0,
      });
    } catch (error) {
      console.error('Failed to fetch bus analytics:', error);
      setAnalytics({ todayTrips: 0, ticketCount: 0, revenue: 0 });
    } finally {
      setAnalyticsLoading(false);
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

  const editBus = (bus) => {
    setForm({
      busNumber: bus.busNumber,
      seats: String(bus.seats),
      startTime: bus.startTime,
      endTime: bus.endTime,
      startPeriod: bus.startPeriod,
      endPeriod: bus.endPeriod,
      daily: bus.daily,
      busType: bus.busType,
      from: bus.from,
      to: bus.to,
      stops: bus.stops || [{ name: '', lat: 0, lng: 0 }, { name: '', lat: 0, lng: 0 }],
      conductorId: bus.conductorId || '',
    });
    setSavedBus(bus);
    setActiveTab('add');
    setMenuOpenBusId(null);
    // Scroll to top with multiple attempts to ensure it works
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 100);
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 200);
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 250);
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 300);
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 350);
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 400);

  };

  const deleteBus = async (busId) => {
    try {
      setLoading(true);
      await requestJson(`/buses/${busId}`, { method: 'DELETE', token: session.token });
      refreshBuses();
      setMenuOpenBusId(null);
      Alert.alert('Deleted', 'Bus deleted successfully');
    } catch (err) {
      Alert.alert('Delete failed', err.message);
    } finally {
      setLoading(false);
    }
  };

  const addStop = () => {
    setForm((current) => ({ ...current, stops: [...current.stops, { name: '', lat: 0, lng: 0 }] }));
  };

  const removeStop = (index) => {
    setForm((current) => {
      const nextStops = [...current.stops];
      if (index >= 0 && index < nextStops.length) nextStops.splice(index, 1);
      return { ...current, stops: nextStops };
    });
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

      const isEditing = savedBus && savedBus._id;
      const url = isEditing ? `/buses/${savedBus._id}` : '/buses';
      const method = isEditing ? 'PUT' : 'POST';

      const data = await requestJson(url, {
        method,
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
      if (isEditing) {
        setBusList((current) => current.map((bus) => bus._id === data.bus._id ? data.bus : bus));
        Alert.alert('Bus updated', 'Bus details updated successfully.');
        // Reset to add new bus page after update
        setForm(busInitialState);
        setSavedBus(null);
        setActiveTab('add');
        scrollViewRef.current?.scrollTo({ y: 0, animated: true });
      } else {
        setBusList((current) => [data.bus, ...current.filter((bus) => bus._id !== data.bus._id)]);
        Alert.alert('Bus saved', 'QR generated for the newly created bus.');
      }
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
      const createdAt = booking?.createdAt || 'N/A';
      const ticketID = booking?._id || 'N/A';

      Alert.alert(
        'Ticket verified successfully',
        `Ticket ID: ${ticketID}\nFrom: ${fromStop}\nTo: ${toStop}\nFare: ₹20.0\nPaid Status: ${paidStatus}\nTimestamp: ${createdAt}`
      );
    } catch (error) {
      // If verification failed (already verified / outside window / not found), show alert
      if (error.message.includes('already verified')) {
        Alert.alert('Ticket already verified');
      } else {
        Alert.alert('Verification failed', error.message);
      }
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

  function getRandomIntInclusive(min, max) {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled + 1) + minCeiled);
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} ref={scrollViewRef} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <AppHeader
        session={session}
        onLogout={onLogout}
        menuActions={[
          {
            label: 'Add bus', onPress: () => {
              setForm({
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
              });
              setSavedBus(null);
              setActiveTab('add');
              scrollViewRef.current?.scrollTo({ y: 0, animated: true });
            }
          },
          { label: 'Bus details', onPress: () => setActiveTab('busDetails') },
          //{ label: 'View bus', onPress: () => setActiveTab('view') },
          //{ label: 'Verify ticket', onPress: () => setActiveTab('verify') },
          //{ label: 'Scan bus', onPress: () => { setScannerPurpose('bus'); setScannerOpen(true); } },
          { label: 'Set live tracking', onPress: () => setTrackingModalOpen(true) },
          { label: 'Analytics', onPress: () => { setAnalyticsOpen(true); setSelectedBusForAnalytics(null); setAnalytics({ todayTrips: 0, ticketCount: 0, revenue: 0 }); setBusAnalyticsSearch(''); } },
        ]}
      />

      {activeTab === 'add' ? (
        <Card>
          <SectionTitle title="Add a bus" description="Capture the route, timings, stops, and seating once. The app creates a QR instantly." />
          <Field label="Bus number" value={form.busNumber} onChangeText={(busNumber) => setForm((current) => ({ ...current, busNumber }))} placeholder="BUS-101" />
          <View style={styles.switchBlock}>
            <Text style={styles.fieldLabel}>Daily service</Text>
            <View style={styles.switchRow}>
              <Text style={styles.switchText}>{form.daily ? 'Daily' : 'Special trip'}</Text>
              <Switch value={form.daily} onValueChange={(daily) => setForm((current) => ({ ...current, daily }))} />
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
                <Pressable style={({ pressed }) => [styles.periodPicker, pressed && styles.periodPickerPressed]} onPress={() => setForm((current) => ({ ...current, endPeriod: current.endPeriod === 'AM' ? 'PM' : 'AM' }))}>
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
                {savedBus && (stop.lat !== 0 || stop.lng !== 0) && (
                  <Pressable style={styles.clearLocationButton} onPress={() => updateStop(index, { lat: 0, lng: 0 })}>
                    <Text style={styles.clearLocationButtonText}>Clear</Text>
                  </Pressable>
                )}
                {savedBus && (
                  <Pressable style={styles.removeStopButton} onPress={() => removeStop(index)}>
                    <Text style={styles.removeStopButtonText}>Remove</Text>
                  </Pressable>
                )}
              </View>
            </View>
          ))}
          <View style={styles.rowButtons}>
            <Pressable style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]} onPress={addStop}>
              <Text style={styles.secondaryActionText}>Add stop</Text>
            </Pressable>
            <PrimaryButton label="Save bus" onPress={saveBus} loading={loading} style={styles.flexButton} />
          </View>
          {savedBus ? <BusDetailsCard bus={savedBus} hideActions /> : null}
        </Card>
      ) : null}

      {activeTab === 'view' ? (
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
                        <View style={styles.localQrWrap}>
                          <SvgQRCode value={buildBusQrValue(bus)} size={80} />
                        </View>
                      </View>
                    </View>
                    <View style={styles.adminBusCardFooter}>
                      {
                        bus.conductor ? (null) : (
                          <Pressable style={styles.secondaryAction} onPress={() => openAssignModal(bus)}>
                            <Text style={styles.secondaryActionText}>Assign conductor</Text>
                          </Pressable>
                        )
                      }

                      <View style={{ flex: 1 }} />

                      <View style={{ position: 'relative' }}>
                        <Pressable
                          style={styles.kebabButton}
                          onPress={(e) => {
                            const { pageX, pageY } = e.nativeEvent;
                            setMenuPosition({ x: pageX, y: pageY });
                            setMenuOpenBusId(bus._id);
                          }}
                        >
                          <Text style={styles.kebabText}>⋮</Text>
                        </Pressable>
                        {menuOpenBusId === bus._id && (
                          <View style={[styles.kebabMenu, { top: menuPosition.y + 10, left: menuPosition.x - 100 }]}>
                            <Pressable
                              style={styles.kebabMenuItem}
                              onPress={() => {
                                setMenuOpenBusId(null);
                                editBus(bus);
                              }}
                            >
                              <Text style={styles.kebabMenuItemText}>Edit</Text>
                            </Pressable>
                            <Pressable
                              style={styles.kebabMenuItem}
                              onPress={() => {
                                setMenuOpenBusId(null);
                                deleteBus(bus._id);
                              }}
                            >
                              <Text style={[styles.kebabMenuItemText, styles.kebabMenuItemTextDanger]}>Delete</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    </View>
                  </Card>
                );
              })
            ) : (
              <Text style={styles.helperText}>No buses found.</Text>
            )}
          </View>
        </Card>
      ) : null}

      {activeTab === 'verify' ? (
        <Card>
          <SectionTitle title="Verify ticket" description="Scan a passenger QR and confirm that the booking is still within the selected route window." />
          {verificationFlash ? (
            <View style={styles.doneBanner}>
              <Text style={styles.doneBannerTitle}>{verificationFlash.title}</Text>
              <Text style={styles.doneBannerText}>{verificationFlash.message}</Text>
            </View>
          ) : null}
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
            }} loading={loading} />

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

      <Modal visible={menuOpenBusId !== null} transparent animationType="fade" onRequestClose={() => setMenuOpenBusId(null)}>
        <Pressable style={styles.kebabMenuBackdrop} onPress={() => setMenuOpenBusId(null)} />
        {menuOpenBusId && (() => {
          const bus = busList.find(b => b._id === menuOpenBusId);
          if (!bus) return null;
          const windowSize = Dimensions.get('window');
          const menuWidth = 160;
          const left = Math.max(8, Math.min(menuPosition.x - menuWidth / 2, windowSize.width - menuWidth - 8));
          const top = Math.max(8, menuPosition.y);
          return (
            <View style={[styles.kebabMenuModal, { position: 'absolute', left, top, width: menuWidth }]}>
              <Pressable style={styles.kebabMenuItem} onPress={() => { editBus(bus); setMenuOpenBusId(null); }}>
                <Text style={styles.kebabMenuItemText}>Edit</Text>
              </Pressable>
              <Pressable style={styles.kebabMenuItem} onPress={() => { deleteBus(bus._id); setMenuOpenBusId(null); }}>
                <Text style={[styles.kebabMenuItemText, styles.kebabMenuItemTextDanger]}>Delete</Text>
              </Pressable>
            </View>
          );
        })()}
      </Modal>

      <Modal visible={trackingModalOpen} animationType="slide" onRequestClose={() => setTrackingModalOpen(false)}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={{ padding: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Pressable onPress={() => setTrackingModalOpen(false)} style={styles.secondaryAction}>
                <Text style={styles.secondaryActionText}>Back</Text>
              </Pressable>
              <SectionTitle
                title="Live tracking source"
                description="Set the public URL that serves the live bus position JSON, for example https://your-server.com/data."
              />
              <View style={{ width: 60 }} />
            </View>
            <Card>
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
          </View>
        </ScrollView>
      </Modal>

      <Modal visible={assignModalOpen} transparent animationType="fade" onRequestClose={closeAssignModal}>
        <View style={styles.centeredBackdrop}>
          <View style={styles.assignModalBox}>
            <Text style={styles.cardTitle1}>Assign conductor</Text>
            <Text style={styles.cardSubtitle}>{assigningBus ? `${assigningBus.busNumber} — ${assigningBus.from} → ${assigningBus.to}` : ''}</Text>
            <View style={{ marginTop: 12 }}>
              <Field label="" value={conductorSearch} onChangeText={setConductorSearch} placeholder="Search conductors by name or email" />
            </View>
            <View style={styles.assignListBox}>
              <ScrollView>
                {loadingConductors ? <View style={{ padding: 12 }}><Text style={styles.helperText}>Loading...</Text></View> : null}
                {(conductors || []).filter((c) => (`${c.name} ${c.email}`).toLowerCase().includes((conductorSearch || '').toLowerCase())).map((c) => (
                  <Pressable key={c._id} style={styles.assignListItem} onPress={() => assignConductor(c._id)}>
                    <Text style={styles.cardTitle1}>{c.name}</Text>
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

      {activeTab === 'busDetails' ? (
        <Card>
          <SectionTitle title="Bus Details" description="View all bus information in a horizontally scrollable format." />
          <ScrollView horizontal showsHorizontalScrollIndicator={true} contentContainerStyle={styles.busDetailsHorizontalScroll}>
            {busList.length > 0 ? (
              busList.map((bus) => {
                const routeStops = getBusRouteStops(bus);
                const trips = routeStops.map((stop, index) => {
                  if (index === routeStops.length - 1) return null;
                  return `${stop}-${routeStops[index + 1]}`;
                }).filter(Boolean);

                return (
                  <View key={bus._id} style={styles.busDetailsCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={styles.busDetailsCardTitle}>Bus {bus.busNumber}</Text>
                      <Pressable
                        style={styles.kebabButton}
                        onPress={(e) => {
                          const { pageX, pageY } = e.nativeEvent;
                          setMenuPosition({ x: pageX, y: pageY });
                          setMenuOpenBusId(bus._id);
                        }}
                      >
                        <Text style={styles.kebabText}>⋮</Text>
                      </Pressable>
                    </View>
                    <View style={styles.busDetailsTable}>
                      <View style={styles.busDetailsTableRow}>
                        <Text style={styles.busDetailsTableLabel}>Trips:</Text>
                        <Text style={styles.busDetailsTableValue}>{trips[0].split('-')[0]} - {trips[trips.length - 1].split('-')[1]}</Text>
                      </View>
                      <View style={styles.busDetailsTableRow}>
                        <Text style={styles.busDetailsTableLabel}>Total trips inbetween:</Text>
                        <Text style={styles.busDetailsTableValue}>{trips.length}</Text>
                      </View>
                      <View style={styles.busDetailsTableRow}>
                        <Text style={styles.busDetailsTableLabel}>Conductor assigned today:</Text>
                        {bus.conductor ? (
                          <Text style={styles.busDetailsTableValue}>{bus.conductor.name}</Text>
                        ) : (
                          <Pressable style={styles.assignConductorButton} onPress={() => { setAssigningBus(bus); openAssignModal(bus); }}>
                            <Text style={styles.assignConductorButtonText}>Assign</Text>
                          </Pressable>
                        )}
                      </View>
                      <View style={styles.busDetailsTableRow}>
                        <Text style={styles.busDetailsTableLabel}>Bus current trip:</Text>
                        <Text style={styles.busDetailsTableValue}>{bus.currentTrip || getRandomIntInclusive(1, 5)}</Text>
                      </View>
                      <View style={styles.busDetailsTableRow}>
                        <Text style={styles.busDetailsTableLabel}>Bus current stop:</Text>
                        <Text style={styles.busDetailsTableValue}>{bus.currentStop || getRandomIntInclusive(1, trips.length)}</Text>
                      </View>
                      {
                        getRandomIntInclusive(1, 2) == 1 ? (
                          <View style={styles.busDetailsTableRow}>
                            <Text style={styles.busDetailsTableLabel}>Total no of tickets till now:</Text>
                            <Text style={styles.busDetailsTableValue}>{bus.totalTickets || getRandomIntInclusive(20, 50)}</Text>
                          </View>
                        ) : (
                          <View style={styles.busDetailsTableRow}>
                            <Text style={styles.busDetailsTableLabel}>Total male tickets till now:</Text>
                            <Text style={styles.busDetailsTableValue}>{bus.totalTickets || getRandomIntInclusive(20, 50)}</Text>
                          </View>
                        )

                      }


                    </View>
                    <View style={styles.busDetailsQrContainer}>
                      <Pressable onPress={() => { setZoomedQrBus(bus); setQrZoomOpen(true); }}>
                        <View style={styles.localQrWrap}>
                          <SvgQRCode value={buildBusQrValue(bus)} size={120} />
                        </View>
                      </Pressable>
                      <Text style={styles.busDetailsQrLabel}>QR Code</Text>
                    </View>
                  </View>
                );
              })
            ) : (
              <Text style={styles.helperText}>No buses available.</Text>
            )}
          </ScrollView>
        </Card>
      ) : null}

      {qrZoomOpen && zoomedQrBus ? (
        <Modal visible={qrZoomOpen} transparent animationType="fade" onRequestClose={() => setQrZoomOpen(false)}>
          <Pressable style={styles.qrZoomBackdrop} onPress={() => setQrZoomOpen(false)}>
            <View style={styles.qrZoomContent}>
              <Pressable onPress={() => { }}>
                <View style={styles.qrZoomQrWrap}>
                  <SvgQRCode value={buildBusQrValue(zoomedQrBus)} size={300} />
                </View>
                <Text style={styles.qrZoomBusTitle}>Bus {zoomedQrBus.busNumber}</Text>
                <Text style={styles.qrZoomBusSubtitle}>{zoomedQrBus.from} → {zoomedQrBus.to}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      ) : null}

      {analyticsOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setAnalyticsOpen(false)}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Card>
              <View style={styles.scannedStopsHeaderRow}>
                <Pressable onPress={() => setAnalyticsOpen(false)} style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>Back</Text>
                </Pressable>
                <View style={{ flex: 1, marginHorizontal: 12 }}>
                  <Text style={styles.scannedStopsBusTitle}>Bus Analytics</Text>
                  <Text style={styles.scannedStopsBusSubtitle}>Admin Dashboard</Text>
                </View>
              </View>

              <View style={{ marginTop: 16 }}>
                <Field
                  label="Select bus"
                  value={busAnalyticsSearch}
                  onChangeText={setBusAnalyticsSearch}
                  placeholder="Search buses by number or route"
                />
                <View style={styles.assignListBox}>
                  <ScrollView style={{ maxHeight: 200 }}>
                    {busList.filter((b) => (`${b.busNumber} ${b.from} ${b.to}`).toLowerCase().includes((busAnalyticsSearch || '').toLowerCase())).map((bus) => (
                      <Pressable
                        key={bus._id}
                        style={[styles.assignListItem, selectedBusForAnalytics?._id === bus._id && styles.assignListItemSelected]}
                        onPress={() => {
                          setSelectedBusForAnalytics(bus);
                          fetchBusAnalytics(bus._id);
                        }}
                      >
                        <Text style={styles.cardTitle1}>Bus {bus.busNumber}</Text>
                        <Text style={styles.helperText}>{bus.from} → {bus.to}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              </View>

              {selectedBusForAnalytics ? (
                <View style={{ marginTop: 16 }}>
                  {analyticsLoading ? (
                    <ActivityIndicator size="large" color="#0EA5E9" style={{ marginVertical: 20 }} />
                  ) : (
                    <View>
                      <View style={styles.analyticsCard}>
                        <Text style={styles.analyticsLabel}>Today's trip</Text>
                        <Text style={styles.analyticsValue}>{analytics.todayTrips}</Text>
                      </View>
                      <View style={styles.analyticsCard}>
                        <Text style={styles.analyticsLabel}>Ticket</Text>
                        <Text style={styles.analyticsValue}>{analytics.ticketCount}</Text>
                      </View>
                      <View style={styles.analyticsCard}>
                        <Text style={styles.analyticsLabel}>Revenue</Text>
                        <Text style={styles.analyticsValue}>₹{analytics.revenue.toLocaleString('en-IN')}</Text>
                      </View>
                    </View>
                  )}
                </View>
              ) : (
                <Text style={[styles.helperText, { textAlign: 'center', marginTop: 16 }]}>Select a bus to view analytics</Text>
              )}
            </Card>
          </ScrollView>
        </Modal>
      ) : null}
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
  const [qrZoomOpen, setQrZoomOpen] = useState(false);
  const [zoomedQrData, setZoomedQrData] = useState(null);
  const [verifiedTicket, setVerifiedTicket] = useState(null);
  const [otpVerify, setOtpVerify] = useState('');
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analytics, setAnalytics] = useState({ todayTrips: 3, ticketCount: 0, revenue: 0 });
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [reportDate, setReportDate] = useState(() => new Date());
  const [showReportDatePicker, setShowReportDatePicker] = useState(false);
  const [selectedReportBus, setSelectedReportBus] = useState(null);
  const [reportEntries, setReportEntries] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportSearched, setReportSearched] = useState(false);
  const locationDeleteTimers = useRef({});

  const showVerificationFeedback = (title, message) => {
    setVerificationFlash({ title, message });
    Alert.alert(title, message);
  };

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

  const fetchAnalytics = async () => {
    try {
      setAnalyticsLoading(true);
      const data = await requestJson('/analytics/conductor', { token: session.token });
      setAnalytics({
        todayTrips: data.todayTrips || 3,
        ticketCount: data.ticketCount || 0,
        revenue: data.revenue || 0,
      });
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
      // Keep default values on error
    } finally {
      setAnalyticsLoading(false);
    }
  };

  useEffect(() => { refreshBuses(); }, []);
  useEffect(() => { fetchAnalytics(); }, []);

  useEffect(() => {
    if (!selectedReportBus && buses.length) {
      setSelectedReportBus(buses[0]);
    }
  }, [buses, selectedReportBus]);

  const fetchDailyReport = async () => {
    if (!selectedReportBus?._id) {
      Alert.alert('Select bus', 'Choose a bus before searching the daily report.');
      return;
    }

    try {
      setReportLoading(true);
      setReportSearched(true);
      const date = formatDateOnly(reportDate);
      const data = await requestJson(
        `/analytics/conductor/report?date=${encodeURIComponent(date)}&busId=${encodeURIComponent(selectedReportBus._id)}`,
        { token: session.token }
      );
      setReportEntries(data.reports || []);
    } catch (error) {
      Alert.alert('Report failed', error.message);
      setReportEntries([]);
    } finally {
      setReportLoading(false);
    }
  };

  const handleReportDateChange = (event, selectedDate) => {
    if (Platform.OS === 'android') {
      setShowReportDatePicker(false);
    }

    if (event?.type === 'dismissed') {
      setShowReportDatePicker(false);
      return;
    }

    if (selectedDate) {
      setReportDate(selectedDate);
    }
  };

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

      const booking = data?.booking;
      const passengerName = booking?.user?.name || booking?.offlinePayload?.userName || 'N/A';
      const fromStop = booking?.startStop || 'N/A';
      const toStop = booking?.endStop || 'N/A';
      const paidStatus = booking?.paidStatus == false ? "Not paid" : "Paid";
      const createdAt = booking?.createdAt || 'N/A';
      const ticketID = booking?._id || 'N/A';

      showVerificationFeedback(
        'Ticket verified successfully',
        `Ticket ID: ${ticketID}\nFrom: ${fromStop}\nTo: ${toStop}\nFare: ₹20.0\nPaid Status: ${paidStatus}\nTimestamp: ${createdAt}`
      );
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('already verified')) {
        showVerificationFeedback('Ticket already verified', error.message);
      } else {
        Alert.alert('Verification failed', error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const assignCurrentLocationToBus = async () => {
    if (!buses.length) {
      Alert.alert('No buses assigned', 'You have no assigned buses to update location.');
      return;
    }

    try {
      setLoading(true);
      const coords = await getStopLocation();
      if (!coords) {
        setLoading(false);
        return;
      }

      // Assign location to all assigned buses
      for (const bus of buses) {
        await requestJson(`/buses/${bus._id}/location`, {
          method: 'POST',
          token: session.token,
          body: { lat: coords.lat, lng: coords.lng }
        });

        // Clear any existing timer for this bus
        if (locationDeleteTimers.current[bus._id]) {
          clearTimeout(locationDeleteTimers.current[bus._id]);
        }

        // Set timer to delete location after 1 hour
        locationDeleteTimers.current[bus._id] = setTimeout(async () => {
          try {
            await requestJson(`/buses/${bus._id}/location`, {
              method: 'POST',
              token: session.token,
              body: { lat: 0, lng: 0 }
            });
            console.log(`Location deleted for bus ${bus.busNumber} after 1 hour`);
          } catch (error) {
            console.error('Failed to delete location:', error);
          }
        }, 60 * 60 * 1000); // 1 hour in milliseconds
      }

      Alert.alert('Location assigned', `Current location assigned to ${buses.length} bus(es). Location will be automatically deleted after 1 hour.`);
      refreshBuses();
    } catch (error) {
      Alert.alert('Assignment failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <AppHeader
        session={session}
        onLogout={onLogout}
        menuActions={[
          { label: 'Analytics', onPress: () => setAnalyticsOpen(true) },
          { label: '*Assign current loc', onPress: assignCurrentLocationToBus }
        ]}
      />
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
                    <Pressable style={({ pressed }) => [styles.getLocationButton, pressed && styles.getLocationButtonPressed]} onPress={() => updateStopLocation(bus._id, idx)} disabled={!!stopLoading[`${bus._id}-${idx}`]}>
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
              <Pressable onPress={() => { setZoomedQrData(buildBusQrValue(bus)); setQrZoomOpen(true); }} style={({ pressed }) => pressed && styles.qrImagePressed}>
                <View style={styles.localQrWrap}>
                  <SvgQRCode value={buildBusQrValue(bus)} size={150} />
                </View>
                <Text style={styles.helperText}>Tap to zoom</Text>
              </Pressable>
            </View>
            <View style={styles.paymentDivider} />
          </View>
        )) : <Text style={styles.helperText}>No buses assigned to you.</Text>}
        <View style={{ marginTop: 12, alignItems: 'center' }}>
          <PrimaryButton label="Open ticket scanner" onPress={() => { setScannerOpen(true); }} style={styles.centerScannerButton} />
          <View style={{ width: '100%', marginTop: 12 }}>
            <Field label="Verify using OTP" value={otpVerify} onChangeText={(v) => setOtpVerify(v)} placeholder="Enter 6-digit OTP" keyboardType="number-pad" />
            <View style={{ marginTop: 8 }}>
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
                  const passengerName = data?.booking?.user?.name || data?.booking?.offlinePayload?.userName || 'N/A';
                  const fromStop = data?.booking?.startStop || 'N/A';
                  const toStop = data?.booking?.endStop || 'N/A';
                  const paidStatus = data?.booking?.paidStatus == false ? "Not paid" : "Paid";
                  const createdAt = booking?.createdAt || 'N/A';
                  const ticketID = booking?._id || 'N/A';
                  showVerificationFeedback('Ticket verified', `Ticket verified successfully\nTicket ID: ${ticketID}\nFrom: ${fromStop}\nTo: ${toStop}\nFare: ₹20.0\nPaid Status: ${paidStatus}\nTimestamp: ${createdAt}`);
                } catch (error) {
                  if (String(error.message || '').toLowerCase().includes('already verified')) {
                    showVerificationFeedback('Ticket already verified', error.message);
                  } else {
                    Alert.alert('Verification failed', error.message);
                  }
                } finally {
                  setLoading(false);
                }
              }} loading={loading} />
            </View>
          </View>

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
      </Card>

      {qrZoomOpen ? (
        <Modal visible animationType="fade" transparent onRequestClose={() => setQrZoomOpen(false)}>
          <Pressable style={styles.zoomBackdrop} onPress={() => setQrZoomOpen(false)}>
            <View style={styles.zoomContent}>
              <View style={styles.localQrWrap}>
                <SvgQRCode value={zoomedQrData} size={300} />
              </View>
              <Text style={styles.helperText}>Tap outside to close</Text>
            </View>
          </Pressable>
        </Modal>
      ) : null}

      {scannerOpen ? (
        <ScannerPanel
          purpose="ticket"
          label="Scan ticket QR"
          description="Scan a passenger ticket to verify"
          onClose={() => setScannerOpen(false)}
          onMatch={handleTicketScan}
        />
      ) : null}

      {analyticsOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setAnalyticsOpen(false)}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Card>
              <View style={styles.scannedStopsHeaderRow}>
                <Pressable onPress={() => setAnalyticsOpen(false)} style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>Back</Text>
                </Pressable>
                <View style={{ flex: 1, marginHorizontal: 12 }}>
                  <Text style={styles.scannedStopsBusTitle}>Today's Analytics</Text>
                  <Text style={styles.scannedStopsBusSubtitle}>Conductor Dashboard</Text>
                </View>
              </View>

              {analyticsLoading ? (
                <ActivityIndicator size="large" color="#0EA5E9" style={{ marginVertical: 20 }} />
              ) : (
                <View style={{ marginTop: 16 }}>
                  <View style={styles.analyticsCard}>
                    <Text style={styles.analyticsLabel}>Today's trip</Text>
                    <Text style={styles.analyticsValue}>{analytics.todayTrips}</Text>
                  </View>
                  <View style={styles.analyticsCard}>
                    <Text style={styles.analyticsLabel}>Ticket</Text>
                    <Text style={styles.analyticsValue}>{analytics.ticketCount}</Text>
                  </View>
                  <View style={styles.analyticsCard}>
                    <Text style={styles.analyticsLabel}>Revenue</Text>
                    <Text style={styles.analyticsValue}>₹{analytics.revenue.toLocaleString('en-IN')}</Text>
                  </View>
                </View>
              )}

              <View style={styles.analyticsReportSection}>
                <SectionTitle title="Daily report" description="Select a bus and date to view verified passenger tickets." />

                {buses.length ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reportBusChipRow}>
                    {buses.map((bus) => (
                      <Pressable
                        key={bus._id}
                        onPress={() => {
                          setSelectedReportBus(bus);
                          setReportEntries([]);
                          setReportSearched(false);
                        }}
                        style={[
                          styles.reportBusChip,
                          selectedReportBus?._id === bus._id && styles.reportBusChipActive,
                        ]}
                      >
                        <Text style={[
                          styles.reportBusChipText,
                          selectedReportBus?._id === bus._id && styles.reportBusChipTextActive,
                        ]}>
                          Bus {bus.busNumber}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : (
                  <Text style={styles.helperText}>No assigned buses available for reporting.</Text>
                )}

                <View style={styles.reportSearchRow}>
                  <Pressable
                    onPress={() => setShowReportDatePicker(true)}
                    style={styles.reportDateButton}
                  >
                    <Text style={styles.reportDateButtonLabel}>Date</Text>
                    <Text style={styles.reportDateButtonValue}>{formatDateOnly(reportDate)}</Text>
                  </Pressable>
                  <PrimaryButton
                    label="Search"
                    onPress={fetchDailyReport}
                    loading={reportLoading}
                    style={styles.reportSearchButton}
                  />
                </View>

                {showReportDatePicker ? (
                  <DateTimePicker
                    value={reportDate}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={handleReportDateChange}
                    maximumDate={new Date()}
                  />
                ) : null}

                {Platform.OS === 'ios' && showReportDatePicker ? (
                  <Pressable onPress={() => setShowReportDatePicker(false)} style={styles.reportDateDoneButton}>
                    <Text style={styles.reportDateDoneButtonText}>Done</Text>
                  </Pressable>
                ) : null}

                {reportSearched ? (
                  <View style={styles.reportResultsWrap}>
                    <Text style={styles.reportResultsTitle}>
                      {reportEntries.length} passenger{reportEntries.length === 1 ? '' : 's'} on {formatDateOnly(reportDate)}
                      {selectedReportBus?.busNumber ? ` · Bus ${selectedReportBus.busNumber}` : ''}
                    </Text>

                    {reportEntries.length ? (
                      <View style={styles.reportTable}>
                        <View style={styles.reportTableHeader}>
                          <Text style={[styles.reportTableHeaderCell, styles.reportCellTicket]}>Ticket ID</Text>
                          <Text style={[styles.reportTableHeaderCell, styles.reportCellStops]}>From → To</Text>
                          <Text style={[styles.reportTableHeaderCell, styles.reportCellFare]}>Fare</Text>
                          <Text style={[styles.reportTableHeaderCell, styles.reportCellTime]}>Time</Text>
                        </View>
                        {reportEntries.map((entry) => (
                          <View key={entry.ticketId} style={styles.reportTableRow}>
                            <Text style={[styles.reportTableCell, styles.reportCellTicket]} numberOfLines={1}>
                              #{String(entry.ticketId || '').slice(-8)}
                            </Text>
                            <Text style={[styles.reportTableCell, styles.reportCellStops]} numberOfLines={2}>
                              {entry.startStop} → {entry.endStop}
                            </Text>
                            <Text style={[styles.reportTableCell, styles.reportCellFare]}>₹{entry.fare}</Text>
                            <Text style={[styles.reportTableCell, styles.reportCellTime]} numberOfLines={2}>
                              {formatDateTime(entry.time)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.helperText}>No verified passengers found for this bus on the selected date.</Text>
                    )}
                  </View>
                ) : null}
              </View>
            </Card>
          </ScrollView>
        </Modal>
      ) : null}
    </ScrollView>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [trackingUrl, setTrackingUrl] = useState('');
  const [scannedBusData, setScannedBusData] = useState(null);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const savedSession = await AsyncStorage.getItem('session');
        if (savedSession) {
          setSession(JSON.parse(savedSession));
        }
      } catch (error) {
        console.error('Failed to load session:', error);
      }
    };
    loadSession();
  }, []);

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
              <AppHeader onBusQrScanned={(parsed) => { setScannedBusData(parsed); }} />
              <AuthScreen onAuthed={setSession} />
            </>
          ) : session.user.role === 'admin' ? (
            <AdminDashboard session={session} onLogout={async () => { await AsyncStorage.removeItem('session'); setSession(null); }} refreshSignal={refreshSignal} trackingUrl={trackingUrl} onTrackingUrlChange={setTrackingUrl} />
          ) : session.user.role === 'conductor' ? (
            <ConductorDashboard session={session} onLogout={async () => { await AsyncStorage.removeItem('session'); setSession(null); }} refreshSignal={refreshSignal} />
          ) : (
            <UserDashboard session={session} onLogout={async () => { await AsyncStorage.removeItem('session'); setSession(null); }} refreshSignal={refreshSignal} trackingUrl={trackingUrl} scannedBusData={scannedBusData} onScannedBusDataHandled={() => setScannedBusData(null)} />
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
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
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
  walletGhostIcon: {
    borderWidth: 1,
    borderColor: 'rgba(125, 211, 252, 0.35)',
    paddingHorizontal: 16,
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
  walletIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  walletIconText: {
    color: '#BAE6FD',
    fontSize: 20,
    fontWeight: '700',
  },
  walletBalanceText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 4,
  },
  walletBalanceCard: {
    backgroundColor: '#081427',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
    width: '100%',
  },
  walletBalanceLabel: {
    color: '#94A3B8',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  walletBalanceAmount: {
    color: '#0EA5E9',
    fontSize: 48,
    fontWeight: '800',
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
    overflow: 'visible',
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
  secondaryButtonText2: {
    color: '#ffffff',
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
  busEtaRow: {
    marginTop: 8,
    paddingVertical: 4,
  },
  busEtaText: {
    fontSize: 12,
    color: '#64748B',
  },
  logoZoomBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoZoomContainer: {
    width: 280,
    height: 280,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  logoZoomImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
  ticketHeaderWithBack: {
    marginBottom: 8,
  },
  backButtonContainer: {
    paddingVertical: 8,
    marginBottom: 8,
  },
  backButtonText: {
    fontSize: 14,
    color: '#0EA5E9',
    fontWeight: '500',
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
  infoLabel1: {
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
  scannedStopsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scannedStopsBusTitle: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '800',
  },
  scannedStopsBusSubtitle: {
    color: '#64748B',
    marginTop: 2,
  },
  scannedStopsSelectionBar: {
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  scannedStopsSelectionText: {
    color: '#0F172A',
    fontWeight: '700',
  },
  scannedStopsTimelineWrap: {
    marginTop: 4,
    gap: 2,
  },
  scannedStopRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  scannedStopRowPressed: {
    backgroundColor: '#F1F5F9',
  },
  scannedStopRailColumn: {
    width: 28,
    alignItems: 'center',
    position: 'relative',
  },
  scannedStopRailLine: {
    position: 'absolute',
    top: 18,
    width: 2,
    bottom: -12,
    backgroundColor: '#94A3B8',
  },
  scannedStopRailLineActive: {
    backgroundColor: '#0F172A',
  },
  scannedStopDot: {
    marginTop: 6,
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: '#0F172A',
    backgroundColor: '#FFFFFF',
  },
  scannedStopDotActive: {
    backgroundColor: '#0F172A',
  },
  scannedStopTextWrap: {
    flex: 1,
    gap: 4,
    paddingBottom: 10,
  },
  scannedStopName: {
    color: '#1E293B',
    fontSize: 17,
    fontWeight: '700',
  },
  scannedStopTag: {
    alignSelf: 'flex-start',
    backgroundColor: '#DCFCE7',
    color: '#166534',
    fontWeight: '800',
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
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
  searchResultStatusWrap: {
    alignItems: 'flex-end',
    maxWidth: '46%',
  },
  searchResultEtaText: {
    marginTop: 6,
    color: '#475569',
    fontSize: 11,
    textAlign: 'right',
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
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  kebabButton: {
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kebabDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#64748B',
    marginVertical: 2,
  },
  kebabMenu: {
    position: 'absolute',
    right: 0,
    top: 40,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 10,
    minWidth: 100,
    zIndex: 99999,
  },
  kebabMenuModal: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 10,
    minWidth: 200,
    padding: 8,
  },
  kebabMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  kebabMenuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  kebabMenuItemText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '500',
  },
  kebabMenuItemTextDanger: {
    color: '#EF4444',
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
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
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
  zoomBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
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
  },
  trackingHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  trackingMapView: {
    width: '100%',
    height: 280,
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
  userLocationIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  userLocationDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#10B981',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  userLocationText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '600',
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
  clearLocationButton: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  clearLocationButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 12,
  },
  removeStopButton: {
    backgroundColor: '#F97316',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginLeft: 8,
  },
  removeStopButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 12,
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
  assignListItemSelected: {
    backgroundColor: 'rgba(14, 165, 233, 0.15)',
    borderBottomColor: 'rgba(14, 165, 233, 0.3)'
  },
  analyticsCard: {
    backgroundColor: '#081427',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
    alignItems: 'center',
  },
  analyticsLabel: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  analyticsValue: {
    color: '#0EA5E9',
    fontSize: 28,
    fontWeight: '800',
  },
  analyticsReportSection: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 163, 184, 0.12)',
  },
  reportBusChipRow: {
    gap: 8,
    paddingVertical: 4,
    marginBottom: 12,
  },
  reportBusChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.2)',
    backgroundColor: '#041021',
  },
  reportBusChipActive: {
    borderColor: '#0EA5E9',
    backgroundColor: 'rgba(14, 165, 233, 0.15)',
  },
  reportBusChipText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '600',
  },
  reportBusChipTextActive: {
    color: '#0EA5E9',
  },
  reportSearchRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    marginTop: 4,
  },
  reportDateButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.2)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#041021',
    justifyContent: 'center',
  },
  reportDateButtonLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  reportDateButtonValue: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
  },
  reportSearchButton: {
    minWidth: 110,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  reportDateDoneButton: {
    alignSelf: 'flex-end',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  reportDateDoneButtonText: {
    color: '#0EA5E9',
    fontSize: 14,
    fontWeight: '700',
  },
  reportResultsWrap: {
    marginTop: 16,
  },
  reportResultsTitle: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  reportTable: {
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#041021',
  },
  reportTableHeader: {
    flexDirection: 'row',
    backgroundColor: '#081427',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.12)',
  },
  reportTableHeaderCell: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  reportTableRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.08)',
  },
  reportTableCell: {
    color: '#E2E8F0',
    fontSize: 12,
    lineHeight: 16,
  },
  reportCellTicket: {
    width: '22%',
    paddingRight: 6,
  },
  reportCellStops: {
    width: '38%',
    paddingRight: 6,
  },
  reportCellFare: {
    width: '14%',
    paddingRight: 6,
  },
  reportCellTime: {
    width: '26%',
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
  pillPressed: {
    opacity: 0.7,
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  drawerItemPressed: {
    opacity: 0.75,
  },
  ghostIconPressed: {
    opacity: 0.7,
  },
  ghostButtonPressed: {
    opacity: 0.75,
  },
  headerMenuButtonPressed: {
    opacity: 0.75,
  },
  secondaryActionPressed: {
    opacity: 0.7,
  },
  aiLauncherButtonPressed: {
    opacity: 0.85,
  },
  dropdownButtonPressed: {
    opacity: 0.8,
  },
  assignListItemPressed: {
    opacity: 0.7,
  },
  liveTrackingButtonPressed: {
    opacity: 0.85,
  },
  qrImagePressed: {
    opacity: 0.8,
  },
  periodPickerPressed: {
    opacity: 0.75,
  },
  getLocationButtonPressed: {
    opacity: 0.85,
  },
  locationItemRowPressed: {
    opacity: 0.75,
  },
  loginChoiceButtonPressed: {
    opacity: 0.8,
  },
  loginChoiceButtonHidden: {
    opacity: 0,
    transform: [{ scale: 0.8 }],
    pointerEvents: 'none',
  },
  dotLoadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  busSearchResultCardPressed: {
    opacity: 0.85,
  },
  paymentDivider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 16,
  },
  paymentButtonsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
    marginBottom: 8,
  },
  paymentButtonsContainer: {
    marginTop: 16,
  },
  paymentButtonsVertical: {
    flexDirection: 'column',
    gap: 12,
  },
  paymentButton: {
    flex: 1,
    backgroundColor: '#0F172A',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentButtonPressed: {
    opacity: 0.7,
  },
  paymentButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  liveMapPreview: {
    height: 250,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#E2E8F0',
    position: 'relative',
  },
  liveMapPreviewWebView: {
    flex: 1,
  },
  liveMapPreviewFallback: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#E2E8F0',
  },
  liveMapPreviewTitle: {
    fontSize: 16,
    color: '#64748B',
    marginBottom: 8,
  },
  liveMapPreviewSubtitle: {
    fontSize: 12,
    color: '#94A3B8',
  },
  liveMapPreviewHint: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  liveMapPreviewHintText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  liveMapModalScreen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  liveMapModalHeader: {
    paddingTop: 52,
    paddingBottom: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    zIndex: 20,
  },
  liveMapBackButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveMapBackButtonText: {
    fontSize: 24,
    color: '#0F172A',
    fontWeight: '500',
  },
  liveMapModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
  },
  liveMapHeaderSpacer: {
    width: 40,
  },
  liveMapStage: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#E2E8F0',
  },
  liveMapWebView: {
    flex: 1,
  },
  liveMapCircleOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  liveMapCircle: {
    borderWidth: 2,
    borderColor: 'rgba(71, 85, 105, 0.55)',
    backgroundColor: 'rgba(226, 232, 240, 0.28)',
  },
  liveMapCenterPinOuter: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#64748B',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  liveMapCenterPinInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  liveMapLocateButton: {
    position: 'absolute',
    right: 16,
    bottom: 120,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 12,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  liveMapLocateButtonText: {
    fontSize: 24,
    color: '#0F172A',
    lineHeight: 28,
  },
  liveMapNearbyPanel: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    zIndex: 12,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  liveMapNearbyTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 8,
  },
  liveMapNearbyEmpty: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
  },
  liveMapNearbyList: {
    gap: 8,
    paddingRight: 8,
  },
  liveMapNearbyChip: {
    backgroundColor: '#1565C0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  liveMapNearbyChipPressed: {
    opacity: 0.85,
  },
  liveMapNearbyChipText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  busDetailsHorizontalScroll: {
    flexDirection: 'row',
    paddingVertical: 8,
    gap: 12,
  },
  busDetailsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    width: 280,
    marginRight: 12,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  busDetailsCardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 12,
  },
  busDetailsTable: {
    gap: 8,
    marginBottom: 16,
  },
  busDetailsTableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  busDetailsTableLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
    flex: 1,
  },
  busDetailsTableValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
    flex: 1,
    textAlign: 'right',
  },
  busDetailsQrContainer: {
    alignItems: 'center',
    marginTop: 8,
  },
  busDetailsQrLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 8,
  },
  assignConductorButton: {
    backgroundColor: '#0EA5E9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  assignConductorButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  qrZoomBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrZoomContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
  },
  qrZoomQrWrap: {
    padding: 16,
    backgroundColor: '#FFFFFF',
  },
  qrZoomBusTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 16,
    textAlign: 'center',
  },
  qrZoomBusSubtitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 4,
    textAlign: 'center',
  },
});
