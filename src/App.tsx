/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Upload, 
  MapPin, 
  Navigation, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  ExternalLink,
  Bike,
  Map as MapIcon,
  List,
  Trash2,
  Navigation2,
  Edit3,
  Sparkles,
  RefreshCw,
  Search,
  Box,
  Clock,
  Sun,
  Moon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Map, { Marker as GLMarker, Source, Layer, NavigationControl, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GoogleGenAI, Type } from "@google/genai";

const getOrderColor = (index: number) => {
  const colors = ['#2563eb', '#3b82f6', '#60a5fa', '#1d4ed8', '#1e40af', '#1e3a8a'];
  return colors[index % colors.length];
};

// --- תיקון המפתח כאן ---
const GENI_KEY = "AIzaSyD..." // כאן הדבקתי את המפתח שלך שנגמר ב-dJrU
const ai = new GoogleGenAI({ apiKey: GENI_KEY });
// -----------------------

interface DeliveryInfo {
  id: string;
  pickup: string;
  pickupHouseNumber?: string;
  pickupBusiness?: string;
  dropoff: string;
  dropoffHouseNumber?: string;
  dropoffBusiness?: string;
  customerName?: string;
  orderId?: string;
  notes?: string;
  urgency: 'high' | 'medium' | 'low';
  urgencyText: string;
  estimatedMinutes?: number;
  distance?: string;
  payment?: string;
  company?: string;
  companyAppUrl?: string;
  priorityScore: number; // 1-100
  timestamp: number;
  pickupCoords?: { lat: number, lng: number };
  dropoffCoords?: { lat: number, lng: number };
  status: 'pending' | 'picked_up' | 'delivered';
}

const getRouteEstimate = async (start: { lat: number, lng: number }, end: { lat: number, lng: number }): Promise<{ distance: number, duration: number } | null> => {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=false`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.code === 'Ok' && data.routes.length > 0) {
      const route = data.routes[0];
      const hour = new Date().getHours();
      let trafficMultiplier = 1.0;
      if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19)) {
        trafficMultiplier = 1.5;
      } else if (hour >= 11 && hour <= 14) {
        trafficMultiplier = 1.2;
      }
      
      return {
        distance: route.distance / 1000,
        duration: (route.duration / 60) * trafficMultiplier
      };
    }
  } catch (err) {
    console.error('Error fetching route estimate:', err);
  }
  return null;
};

const geocodeAddress = async (address: string, houseNumber?: string, userLoc?: { lat: number, lng: number } | null): Promise<{ lat: number, lng: number, display_name?: string } | null> => {
  if (!address) return null;
  
  const cleanHebrewAddress = (addr: string) => {
    if (!addr) return '';
    let cleaned = addr.replace(/^(כתובת|לכתובת|יעד|מסירה|איסוף|מקור|מבית|לבית|שם|לקוח|הזמנה|פרטי הזמנה|פרטי משלוח|הערות|הערה):\s*/i, '')
      .replace(/:/g, ' ')
      .replace(/([א-ת]+)(\d+)/g, '$1 $2')
      .replace(/[^\u0590-\u05FF0-9\s,.'"-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
      
    cleaned = cleaned.replace(/(קומה|דירה|כניסה|קומת|דירת|כניסת|בניין|בית|מספר|מס'|מעלית|קוד|קודן|אינטרקום|טלפון|נייד|שם|לקוח|הערה|הערות)\s+\d+/g, '');
    cleaned = cleaned.replace(/(קומה|דירה|כניסה|קומת|דירת|כניסת|בניין|בית|מספר|מס'|מעלית|קוד|קודן|אינטרקום|טלפון|נייד|שם|לקוח|הערה|הערות)/g, '');

    const abbrevMap: Record<string, string> = { 
      'שד': 'שדרות', 'רח': 'רחוב', 'ק': 'קריית', 'ג': 'גבעת', 'סמ': 'סמטה', 'כ': 'כיכר', 'מ': 'מרכז',
      'שד\'': 'שדרות', 'רח\'': 'רחוב', 'ק\'': 'קריית', 'ג\'': 'גבעת', 'סמ\'': 'סמטה', 'כ\'': 'כיכר', 'מ\'': 'מרכז',
      'שד׳': 'שדרות', 'רח׳': 'רחוב', 'ק׳': 'קריית', 'ג׳': 'גבעת', 'סמ׳': 'סמטה', 'כ׳': 'כיכר', 'מ׳': 'מרכז',
      'שד"ל': 'שדרות', 'רח"ב': 'רחוב', 'א': 'אזור', 'ת': 'תל', 'י': 'ירושלים', 'ח': 'חיפה', 'ב': 'באר', 'ש': 'שבע'
    };
    
    cleaned = cleaned.split(' ').map(word => {
      const cleanWord = word.replace(/[.'"-]$/, '');
      return abbrevMap[word] || abbrevMap[cleanWord] || word;
    }).join(' ');
    
    const words = cleaned.split(/\s+/);
    return words.filter((w, i) => words.indexOf(w) === i).join(' ').replace(/[,\s]+$/, '').trim();
  };

  const tryPhoton = async (query: string) => {
    if (!query || query.length < 3) return null;
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1&lang=he&lat=${userLoc?.lat || 32.0853}&lon=${userLoc?.lng || 34.7818}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (data.features?.length > 0) {
        const f = data.features[0];
        const p = f.properties;
        const name = `${p.name || ''}${p.housenumber ? ' ' + p.housenumber : ''}, ${p.city || p.state || ''}`;
        return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], display_name: name };
      }
      return null;
    } catch (e) { return null; }
  };

  const tryArcGIS = async (query: string) => {
    if (!query || query.length < 3) return null;
    try {
      const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&singleLine=${encodeURIComponent(query)}&maxLocations=1&location=${userLoc?.lng || 34.7818},${userLoc?.lat || 32.0853}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (data.candidates?.length > 0) {
        const c = data.candidates[0];
        return { lat: c.location.y, lng: c.location.x, display_name: c.address };
      }
      return null;
    } catch (e) { return null; }
  };

  const tryNominatim = async (query: string) => {
    if (!query || query.length < 3) return null;
    try {
      let baseUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=il&addressdetails=1`;
      
      if (userLoc) {
        const viewboxSize = 0.2;
        const viewbox = `${userLoc.lng - viewboxSize},${userLoc.lat + viewboxSize},${userLoc.lng + viewboxSize},${userLoc.lat - viewboxSize}`;
        const boundedUrl = `${baseUrl}&viewbox=${viewbox}&bounded=1`;
        const res = await fetch(boundedUrl, { 
          headers: { 'Accept-Language': 'he', 'User-Agent': 'BicycleDeliveryAssistant/1.1' },
          signal: AbortSignal.timeout(2000)
        });
        const data = await res.json();
        if (data && data.length > 0) {
          const addr = data[0].address;
          const cleanName = addr.road ? `${addr.road}${addr.house_number ? ' ' + addr.house_number : ''}, ${addr.city || addr.town || addr.village || ''}` : data[0].display_name;
          return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display_name: cleanName };
        }
      }

      let biasUrl = baseUrl;
      if (userLoc) {
        const viewboxSize = 1.0;
        const viewbox = `${userLoc.lng - viewboxSize},${userLoc.lat + viewboxSize},${userLoc.lng + viewboxSize},${userLoc.lat - viewboxSize}`;
        biasUrl += `&viewbox=${viewbox}&bounded=0`;
      }
      
      const res = await fetch(biasUrl, { 
        headers: { 'Accept-Language': 'he', 'User-Agent': 'BicycleDeliveryAssistant/1.1' },
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json();
      if (data && data.length > 0) {
        const addr = data[0].address;
        const cleanName = addr.road ? `${addr.road}${addr.house_number ? ' ' + addr.house_number : ''}, ${addr.city || addr.town || addr.village || ''}` : data[0].display_name;
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display_name: cleanName };
      }
      return null;
    } catch (e) { return null; }
  };

  const cleaned = cleanHebrewAddress(address);
  const addressParts = cleaned.split(',').map(p => p.trim());
  
  const queries = [];
  
  const nearMatch = cleaned.match(/(?:ליד|מול)\s+(.+)/);
  if (nearMatch) {
    const target = nearMatch[1];
    const base = cleaned.replace(/(?:ליד|מול)\s+.+/, '').trim();
    if (base) queries.push(base);
    queries.push(target);
    if (addressParts.length > 1) {
      const city = addressParts[addressParts.length - 1];
      queries.push(`${target}, ${city}`);
    }
  }

  if (houseNumber && !cleaned.includes(houseNumber)) {
    queries.push(addressParts.length > 1 ? `${addressParts[0]} ${houseNumber}, ${addressParts[1]}` : `${cleaned} ${houseNumber}`);
  }
  queries.push(cleaned);
  if (addressParts.length > 1) {
    queries.push(`${addressParts[0]}, ${addressParts[1]}`);
    if (!addressParts[0].startsWith('ה')) queries.push(`ה${addressParts[0]}, ${addressParts[1]}`);
  }

  const services = [tryPhoton, tryArcGIS, tryNominatim];
  
  for (const service of services) {
    for (const q of queries) {
      const res = await service(q);
      if (res) return res;
    }
  }

  const fuzzyQueries = queries.map(q => q.replace(/(רחוב|שדרות|סמטת|דרך|כיכר|מרכז|ליד|מול|ליד ה|מול ה)\s+/g, '').trim()).filter(q => !queries.includes(q));
  if (fuzzyQueries.length > 0) {
    for (const service of services) {
      for (const q of fuzzyQueries) {
        const res = await service(q);
        if (res) return res;
      }
    }
  }

  if (addressParts.length > 1) {
    const city = addressParts[addressParts.length - 1];
    const cityRes = await tryPhoton(city) || await tryArcGIS(city) || await tryNominatim(city);
    if (cityRes) return cityRes;
  }

  return null;
};

const getAddressSuggestions = async (query: string, userLoc?: { lat: number, lng: number } | null): Promise<any[]> => {
  if (query.length < 2) return [];
  try {
    let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&countrycodes=il&addressdetails=1`;
    
    if (userLoc) {
      const viewboxSize = 0.3;
      const viewbox = `${userLoc.lng - viewboxSize},${userLoc.lat + viewboxSize},${userLoc.lng + viewboxSize},${userLoc.lat - viewboxSize}`;
      url += `&viewbox=${viewbox}`;
    }

    const response = await fetch(url, {
      headers: { 'Accept-Language': 'he,en', 'User-Agent': 'DeliveryAssistantApp/1.1' }
    });
    
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    return [];
  }
};

const GLMap = ({ center, orders, activeDestination, activeOrderId, heading, isAutoRotate, setIsAutoRotate, is3D, setIs3D, isDarkMode }: { center: { lat: number, lng: number } | null, orders: DeliveryInfo[], activeDestination: { lat: number, lng: number } | null, activeOrderId: string | null, heading: number | null, isAutoRotate: boolean, setIsAutoRotate: (v: boolean) => void, is3D: boolean, setIs3D: (v: boolean) => void, isDarkMode: boolean }) => {
  const mapRef = useRef<MapRef>(null);
  const [route, setRoute] = useState<any>(null);
  const [viewState, setViewState] = useState({
    latitude: center?.lat || 32.0853,
    longitude: center?.lng || 34.7818,
    zoom: 13,
    pitch: is3D ? 45 : 0,
    bearing: heading || 0
  });

  useEffect(() => {
    if (center && isAutoRotate) {
      setViewState(prev => ({
        ...prev,
        latitude: center.lat,
        longitude: center.lng,
        bearing: heading || prev.bearing,
        transitionDuration: 500
      }));
    }
  }, [center, heading, isAutoRotate]);

  useEffect(() => {
    setViewState(prev => ({
      ...prev,
      pitch: is3D ? 60 : 0,
      zoom: is3D ? Math.max(prev.zoom, 17.5) : prev.zoom,
      transitionDuration: 1000
    }));
  }, [is3D]);

  useEffect(() => {
    const fetchRoute = async () => {
      if (!center || !activeDestination) {
        setRoute(null);
        return;
      }
      try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${center.lng},${center.lat};${activeDestination.lng},${activeDestination.lat}?overview=full&geometries=geojson`);
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
          setRoute(data.routes[0].geometry);
        }
      } catch (e) {
        console.error("Routing error:", e);
      }
    };
    fetchRoute();
  }, [center, activeDestination]);

  useEffect(() => {
    if (!mapRef.current || isAutoRotate || activeDestination) return;

    const activeOrders = orders.filter(o => o.status !== 'delivered');
    const points: [number, number][] = [];
    
    if (center) points.push([center.lng, center.lat]);
    activeOrders.forEach(o => {
      if (o.pickupCoords) points.push([o.pickupCoords.lng, o.pickupCoords.lat]);
      if (o.dropoffCoords) points.push([o.dropoffCoords.lng, o.dropoffCoords.lat]);
    });

    if (points.length >= 2) {
      const lats = points.map(p => p[1]);
      const lngs = points.map(p => p[0]);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);

      mapRef.current.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        { padding: 80, duration: 1000 }
      );
    }
  }, [orders, center, isAutoRotate, activeDestination]);

  const activeOrders = orders.filter(o => o.status !== 'delivered');

  return (
    <Map
      ref={mapRef}
      {...viewState}
      onMove={evt => setViewState(evt.viewState)}
      onLoad={(e) => {
        const map = e.target;
        const layers = map.getStyle().layers;
        if (layers) {
          layers.forEach(layer => {
            if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
              map.setLayoutProperty(layer.id, 'text-field', [
                'coalesce',
                ['get', 'name:en'],
                ['get', 'name_en'],
                ['get', 'name']
              ]);
            }
          });
        }
      }}
      style={{ width: '100%', height: '100%' }}
      mapStyle={isDarkMode ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"}
    >
      
      {center && (
        <GLMarker latitude={center.lat} longitude={center.lng}>
          <div className="relative flex items-center justify-center">
            <div className="absolute w-8 h-8 bg-blue-400/20 rounded-full blur-sm" />
            <motion.div 
              animate={{ 
                scale: is3D ? 1.1 : 1
              }}
              className={`relative z-10 rounded-full border-[1.5px] border-white shadow-md transition-all duration-500 ${is3D ? 'w-5 h-5 bg-blue-600' : 'w-4 h-4 bg-blue-500'}`}
            >
              {heading !== null && (
                <div 
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ transform: `rotate(${heading}deg)` }}
                >
                  <div className="w-0.5 h-2 bg-white/90 rounded-full mb-2.5" />
                </div>
              )}
            </motion.div>
          </div>
        </GLMarker>
      )}

      {activeOrders.map((order, idx) => {
        const color = getOrderColor(idx);
        return (
          <React.Fragment key={order.id}>
            {order.pickupCoords && order.status === 'pending' && (
              <GLMarker latitude={order.pickupCoords.lat} longitude={order.pickupCoords.lng}>
                <div className="group relative cursor-pointer">
                  <div className="w-8 h-8 flex items-center justify-center rounded-full border-2 border-white shadow-lg text-white font-bold text-xs transition-transform hover:scale-110" style={{ backgroundColor: color }}>P</div>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-white dark:bg-slate-900 px-2 py-1 rounded shadow dark:shadow-2xl text-[10px] whitespace-nowrap text-black dark:text-slate-50 border dark:border-slate-800">
                    {order.pickup}
                  </div>
                </div>
              </GLMarker>
            )}
            {order.dropoffCoords && (
              <GLMarker latitude={order.dropoffCoords.lat} longitude={order.dropoffCoords.lng}>
                <div className="group relative cursor-pointer">
                  <div className="w-8 h-8 flex items-center justify-center rounded-full border-2 border-white shadow-lg text-white font-bold text-xs transition-transform hover:scale-110" style={{ backgroundColor: color }}>D</div>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-white dark:bg-slate-900 px-2 py-1 rounded shadow dark:shadow-2xl text-[10px] whitespace-nowrap text-black dark:text-slate-50 border dark:border-slate-800">
                    {order.dropoff}
                  </div>
                </div>
              </GLMarker>
            )}
          </React.Fragment>
        );
      })}

      {route && (
        <Source id="route-source" type="geojson" data={{ type: 'Feature', properties: {}, geometry: route }}>
          <Layer
            id="route"
            type="line"
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{
              'line-color': activeOrderId ? getOrderColor(orders.findIndex(o => o.id === activeOrderId)) : '#2563eb',
              'line-width': 4,
              'line-opacity': 0.6
            }}
          />
        </Source>
      )}

      <Layer
        id="3d-buildings"
        source="carto"
        source-layer="building"
        type="fill-extrusion"
        minzoom={15}
        paint={{
          'fill-extrusion-color': isDarkMode ? '#1e293b' : '#e2e8f0',
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-opacity': is3D ? 0.6 : 0
        }}
      />
    </Map>
  );
};

export default function App() {
  const [images, setImages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ pickup: '', pickupHouseNumber: '', dropoff: '', dropoffHouseNumber: '', customerName: '', orderId: '', notes: '' });
  const [suggestions, setSuggestions] = useState<{type: 'pickup' | 'dropoff', list: any[]}>({ type: 'pickup', list: [] });
  const [orders, setOrders] = useState<DeliveryInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [userLocation, setUserLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [activeDestination, setActiveDestination] = useState<{ lat: number, lng: number } | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [activeOrderType, setActiveOrderType] = useState<'pickup' | 'dropoff' | null>(null);
  const [deviceHeading, setDeviceHeading] = useState<number | null>(null);
  const [isAutoRotate, setIsAutoRotate] = useState(false);
  const [is3D, setIs3D] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });
  const mapRef = useRef<MapRef>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [totalEarnings, setTotalEarnings] = useState(0);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [navEstimate, setNavEstimate] = useState<{ distance: string, duration: number, eta: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (userLocation && activeDestination && viewMode === 'map') {
      const updateNavEstimate = async () => {
        const estimate = await getRouteEstimate(userLocation, activeDestination);
        if (estimate) {
          const now = new Date();
          const etaDate = new Date(now.getTime() + estimate.duration * 60000);
          const eta = etaDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
          setNavEstimate({
            distance: `${estimate.distance.toFixed(1)} ק"מ`,
            duration: Math.round(estimate.duration),
            eta
          });
        }
      };
      updateNavEstimate();
      const interval = setInterval(updateNavEstimate, 10000);
      return () => clearInterval(interval);
    } else {
      setNavEstimate(null);
    }
  }, [userLocation, activeDestination, viewMode]);

  useEffect(() => {
    if ("geolocation" in navigator) {
      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          setUserLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
        },
        (error) => console.error("Geolocation error:", error),
        { enableHighAccuracy: true }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  useEffect(() => {
    const fetchSuggestions = async () => {
      const query = suggestions.type === 'pickup' ? editForm.pickup : editForm.dropoff;
      if (query.length >= 2) {
        const list = await getAddressSuggestions(query, userLocation);
        setSuggestions(prev => ({ ...prev, list }));
      } else {
        setSuggestions(prev => ({ ...prev, list: [] }));
      }
    };

    const timer = setTimeout(fetchSuggestions, 500);
    return () => clearTimeout(timer);
  }, [editForm.pickup, editForm.dropoff, suggestions.type]);

  const manualSearch = async (type: 'pickup' | 'dropoff') => {
    const query = type === 'pickup' ? editForm.pickup : editForm.dropoff;
    if (query.length >= 2) {
      setIsProcessing(true);
      const list = await getAddressSuggestions(query, userLocation);
      setSuggestions({ type, list });
      setIsProcessing(false);
    }
  };

  const saveEditedOrder = async (id: string) => {
    const order = orders.find(o => o.id === id);
    if (!order) return;

    setIsProcessing(true);
    try {
      const [pickupRes, dropoffRes] = await Promise.all([
        geocodeAddress(editForm.pickup, editForm.pickupHouseNumber, userLocation),
        geocodeAddress(editForm.dropoff, editForm.dropoffHouseNumber, userLocation)
      ]);

      const pickupCoords = pickupRes ? { lat: pickupRes.lat, lng: pickupRes.lng } : undefined;
      const dropoffCoords = dropoffRes ? { lat: dropoffRes.lat, lng: dropoffRes.lng } : undefined;

      let routeInfo = null;
      if (pickupCoords && dropoffCoords) {
        routeInfo = await getRouteEstimate(pickupCoords, dropoffCoords);
      }

      setOrders(prev => prev.map(o => o.id === id ? { 
        ...o, 
        pickup: pickupRes?.display_name || editForm.pickup, 
        pickupHouseNumber: editForm.pickupHouseNumber,
        dropoff: dropoffRes?.display_name || editForm.dropoff,
        dropoffHouseNumber: editForm.dropoffHouseNumber,
        customerName: editForm.customerName,
        orderId: editForm.orderId,
        notes: editForm.notes,
        pickupCoords: pickupCoords || o.pickupCoords,
        dropoffCoords: dropoffCoords || o.dropoffCoords,
        estimatedMinutes: routeInfo?.duration || o.estimatedMinutes,
        distance: routeInfo ? `${routeInfo.distance.toFixed(1)} ק"מ` : o.distance
      } : o));
      setEditingOrderId(null);
    } catch (err) {
      setError("שגיאה בעדכון הכתובת");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      Array.from(files).forEach((file: File) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          setImages(prev => [...prev, result]);
          processImages([result]);
        };
        reader.readAsDataURL(file);
      });
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const processImages = async (imagesToProcess: string[]) => {
    if (imagesToProcess.length === 0) return;

    setIsProcessing(true);
    setProcessingProgress(prev => ({ 
      current: prev.current, 
      total: prev.total + imagesToProcess.length 
    }));
    setError(null);

    const processSingleImage = async (imgData: string) => {
      let retries = 0;
      const maxRetries = 5;

      while (retries <= maxRetries) {
        try {
          if (retries > 0) {
            const delay = 2000 * Math.pow(2, retries - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 500));
          }
          
          const base64Data = imgData.split(',')[1];
          const response = await ai.models.generateContent({
            model: "gemini-1.5-flash", // שימוש במודל פלאש למהירות
            contents: [
              {
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: base64Data } },
                  { text: `Analyze this Israeli delivery app screenshot (Wolt, 10bis, Mishloha, etc.) and extract all relevant logistics data.` }
                ]
              }
            ],
            config: {
              systemInstruction: "You are a professional logistics dispatcher in Israel. Output JSON values in Hebrew.",
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  pickup: { type: Type.STRING },
                  pickupHouseNumber: { type: Type.STRING, nullable: true },
                  pickupBusiness: { type: Type.STRING, nullable: true },
                  dropoff: { type: Type.STRING },
                  dropoffHouseNumber: { type: Type.STRING, nullable: true },
                  dropoffBusiness: { type: Type.STRING, nullable: true },
                  customerName: { type: Type.STRING, nullable: true },
                  orderId: { type: Type.STRING, nullable: true },
                  notes: { type: Type.STRING, nullable: true },
                  urgency: { type: Type.STRING, enum: ["high", "medium", "low"] },
                  urgencyText: { type: Type.STRING },
                  estimatedMinutes: { type: Type.NUMBER, nullable: true },
                  distance: { type: Type.STRING, nullable: true },
                  payment: { type: Type.STRING, nullable: true },
                  company: { type: Type.STRING, nullable: true },
                  priorityScore: { type: Type.NUMBER }
                },
                required: ["pickup", "dropoff", "urgency", "urgencyText", "priorityScore"]
              }
            }
          });

          const text = response.text();
          if (!text) return null;

          const result = JSON.parse(text);
          
          const [pickupRes, dropoffRes] = await Promise.all([
            geocodeAddress(result.pickup, result.pickupHouseNumber, userLocation),
            geocodeAddress(result.dropoff, result.dropoffHouseNumber, userLocation)
          ]);

          const pickupCoords = pickupRes ? { lat: pickupRes.lat, lng: pickupRes.lng } : undefined;
          const dropoffCoords = dropoffRes ? { lat: dropoffRes.lat, lng: dropoffRes.lng } : undefined;
          
          let routeInfo = null;
          if (pickupCoords && dropoffCoords) {
            routeInfo = await getRouteEstimate(pickupCoords, dropoffCoords);
          }

          return {
            id: Math.random().toString(36).substr(2, 9),
            ...result,
            pickup: pickupRes?.display_name || result.pickup,
            dropoff: dropoffRes?.display_name || result.dropoff,
            timestamp: Date.now(),
            pickupCoords,
            dropoffCoords,
            estimatedMinutes: routeInfo?.duration || result.estimatedMinutes,
            distance: routeInfo ? `${routeInfo.distance.toFixed(1)} ק"מ` : result.distance,
            status: 'pending' as const
          };
        } catch (e: any) {
          if (e.status === 429) {
            retries++;
            continue;
          }
          console.error("Image processing error:", e);
          return null;
        }
      }
      return null;
    };

    for (const img of imagesToProcess) {
      const result = await processSingleImage(img);
      if (result) {
        setOrders(prev => [...prev, result]);
      }
      setProcessingProgress(prev => ({ ...prev, current: prev.current + 1 }));
    }

    setIsProcessing(false);
    setProcessingProgress({ current: 0, total: 0 });
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark bg-slate-950 text-slate-50' : 'bg-slate-50 text-slate-900'} font-sans selection:bg-blue-100 dark:selection:bg-blue-900`}>
      <header className="fixed top-0 inset-x-0 h-16 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 z-50 px-4 flex items-center justify-between transition-colors duration-300">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Bike className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">CouriAI</h1>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">מערכת ניהול משלוחים</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 mx-1" />
          <button 
            onClick={() => setViewMode(viewMode === 'list' ? 'map' : 'list')}
            className="flex items-center gap-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-4 py-2.5 rounded-xl font-semibold text-sm shadow-xl shadow-slate-900/10 dark:shadow-white/5 active:scale-95 transition-all"
          >
            {viewMode === 'list' ? (
              <><MapIcon size={18} /> <span>מפה</span></>
            ) : (
              <><List size={18} /> <span>רשימה</span></>
            )}
          </button>
        </div>
      </header>

      <main className="pt-16 min-h-screen">
        {viewMode === 'list' ? (
          <div className="max-w-xl mx-auto p-4 space-y-6">
             {/* כאן יבוא שאר הקוד של הרשימה */}
             <p className="text-center py-10">העלה צילום מסך כדי להתחיל...</p>
          </div>
        ) : (
          <div className="fixed inset-0 pt-16 z-10">
            <GLMap 
              center={userLocation} 
              orders={orders} 
              activeDestination={activeDestination}
              activeOrderId={activeOrderId}
              heading={deviceHeading}
              isAutoRotate={isAutoRotate}
              setIsAutoRotate={setIsAutoRotate}
              is3D={is3D}
              setIs3D={setIs3D}
              isDarkMode={isDarkMode}
            />
          </div>
        )}
      </main>

      <div className="fixed bottom-6 inset-x-0 flex justify-center z-50 pointer-events-none">
        <label className="pointer-events-auto group relative cursor-pointer active:scale-95 transition-transform">
          <div className="absolute inset-0 bg-blue-600 rounded-full blur-xl opacity-20 group-hover:opacity-40 transition-opacity" />
          <div className="relative bg-blue-600 text-white p-5 rounded-full shadow-2xl shadow-blue-600/20 flex items-center justify-center border-4 border-white dark:border-slate-950">
            <Upload size={28} />
          </div>
          <input 
            type="file" 
            ref={fileInputRef}
            className="hidden" 
            accept="image/*" 
            multiple 
            onChange={handleImageUpload}
          />
        </label>
      </div>
    </div>
  );
}