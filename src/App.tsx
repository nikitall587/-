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
  Box
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Map, { Marker as GLMarker, Source, Layer, NavigationControl, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GoogleGenAI, Type } from "@google/genai";

// Fix Leaflet marker icons - No longer needed as we switched to MapLibre

const getOrderColor = (index: number) => {
  const colors = ['#2563eb', '#3b82f6', '#60a5fa', '#1d4ed8', '#1e40af', '#1e3a8a'];
  return colors[index % colors.length];
};

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface DeliveryInfo {
  id: string;
  pickup: string;
  pickupHouseNumber?: string;
  pickupBusiness?: string;
  dropoff: string;
  dropoffHouseNumber?: string;
  dropoffBusiness?: string;
  customerName?: string;
  orderNumber?: string;
  urgency: 'high' | 'medium' | 'low';
  urgencyText: string;
  estimatedMinutes?: number;
  distance?: string;
  payment?: string;
  priorityScore: number; // 1-100
  timestamp: number;
  pickupCoords?: { lat: number, lng: number };
  dropoffCoords?: { lat: number, lng: number };
  status: 'pending' | 'picked_up' | 'delivered';
}

// Advanced Geocoding utility with Hebrew normalization and hierarchical search
const geocodeAddress = async (address: string, houseNumber?: string, userLoc?: { lat: number, lng: number } | null): Promise<{ lat: number, lng: number, display_name?: string } | null> => {
  if (!address) return null;
  
  const cleanHebrewAddress = (addr: string) => {
    if (!addr) return '';
    // Remove introductory words and colons
    let cleaned = addr.replace(/(איסוף|מסירה|כתובת|ליעד|מקור|הזמנה|משלוח|יעד|מוצא|מבית|לבית|ליד|מול)\s*:?/g, ' ')
      .replace(/([א-ת]+)(\d+)/g, '$1 $2') // Space between letters and numbers
      .replace(/[^\u0590-\u05FF0-9\s,.'"-]/g, ' ') // Keep Hebrew, numbers, spaces, commas, quotes, dots
      .replace(/\s+/g, ' ')
      .trim();
      
    // Comprehensive abbreviation expansion
    const abbrevMap: Record<string, string> = { 
      'שד': 'שדרות', 'רח': 'רחוב', 'ק': 'קריית', 'ג': 'גבעת', 'סמ': 'סמטה', 'כ': 'כיכר', 'מ': 'מרכז',
      'שד\'': 'שדרות', 'רח\'': 'רחוב', 'ק\'': 'קריית', 'ג\'': 'גבעת', 'סמ\'': 'סמטה', 'כ\'': 'כיכר', 'מ\'': 'מרכז',
      'שד׳': 'שדרות', 'רח׳': 'רחוב', 'ק׳': 'קריית', 'ג׳': 'גבעת', 'סמ׳': 'סמטה', 'כ׳': 'כיכר', 'מ׳': 'מרכז',
      'שד"ל': 'שדרות', 'רח"ב': 'רחוב'
    };
    
    cleaned = cleaned.split(' ').map(word => {
      const cleanWord = word.replace(/[.'"-]$/, '');
      return abbrevMap[word] || abbrevMap[cleanWord] || word;
    }).join(' ');
    
    // Deduplicate
    const words = cleaned.split(/\s+/);
    return words.filter((w, i) => words.indexOf(w) === i).join(' ').replace(/[,\s]+$/, '');
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

  const tryNominatim = async (query: string) => {
    if (!query || query.length < 3) return null;
    try {
      let baseUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=il&addressdetails=1`;
      
      // Attempt 1: Bounded search (strict)
      if (userLoc) {
        const viewboxSize = 0.2; // ~20km radius
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

      // Attempt 2: Unbounded search with bias
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
  
  // Construct queries
  const queries = [];
  if (houseNumber && !cleaned.includes(houseNumber)) {
    queries.push(addressParts.length > 1 ? `${addressParts[0]} ${houseNumber}, ${addressParts[1]}` : `${cleaned} ${houseNumber}`);
  }
  queries.push(cleaned);
  if (addressParts.length > 1) {
    queries.push(`${addressParts[0]}, ${addressParts[1]}`); // Street, City
    if (!addressParts[0].startsWith('ה')) queries.push(`ה${addressParts[0]}, ${addressParts[1]}`); // ה + Street, City
  }

  // Try Photon first (fast)
  for (const q of queries) {
    const res = await tryPhoton(q);
    if (res) return res;
  }

  // Try Nominatim as fallback (slower but more reliable)
  for (const q of queries) {
    const res = await tryNominatim(q);
    if (res) return res;
  }

  // Last resort: City ONLY
  if (addressParts.length > 1) {
    const city = addressParts[addressParts.length - 1];
    const cityRes = await tryPhoton(city) || await tryNominatim(city);
    if (cityRes) return cityRes;
  }

  return null;
};

const getAddressSuggestions = async (query: string, userLoc?: { lat: number, lng: number } | null): Promise<any[]> => {
  if (query.length < 2) return [];
  try {
    let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&countrycodes=il&addressdetails=1`;
    
    if (userLoc) {
      const viewboxSize = 0.3; // ~30km radius
      const viewbox = `${userLoc.lng - viewboxSize},${userLoc.lat + viewboxSize},${userLoc.lng + viewboxSize},${userLoc.lat - viewboxSize}`;
      url += `&viewbox=${viewbox}`; // No bounded=1 to allow broad search
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

const GLMap = ({ center, orders, activeDestination, activeOrderId, heading, isAutoRotate, setIsAutoRotate, is3D, setIs3D }: { center: { lat: number, lng: number } | null, orders: DeliveryInfo[], activeDestination: { lat: number, lng: number } | null, activeOrderId: string | null, heading: number | null, isAutoRotate: boolean, setIsAutoRotate: (v: boolean) => void, is3D: boolean, setIs3D: (v: boolean) => void }) => {
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
      mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
    >
      {/* Map Content */}
      
      {center && (
        <GLMarker latitude={center.lat} longitude={center.lng}>
          <div className="relative flex items-center justify-center">
            {/* Subtle Glow */}
            <div className="absolute w-8 h-8 bg-blue-400/20 rounded-full blur-sm" />
            
            {/* Main Dot */}
            <motion.div 
              animate={{ 
                scale: is3D ? 1.1 : 1
              }}
              className={`relative z-10 rounded-full border-[1.5px] border-white shadow-md transition-all duration-500 ${is3D ? 'w-5 h-5 bg-blue-600' : 'w-4 h-4 bg-blue-500'}`}
            >
              {/* Direction Indicator - Subtle */}
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
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-white px-2 py-1 rounded shadow text-[10px] whitespace-nowrap text-black">
                    {order.pickup}
                  </div>
                </div>
              </GLMarker>
            )}
            {order.dropoffCoords && (
              <GLMarker latitude={order.dropoffCoords.lat} longitude={order.dropoffCoords.lng}>
                <div className="group relative cursor-pointer">
                  <div className="w-8 h-8 flex items-center justify-center rounded-full border-2 border-white shadow-lg text-white font-bold text-xs transition-transform hover:scale-110" style={{ backgroundColor: color }}>D</div>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-white px-2 py-1 rounded shadow text-[10px] whitespace-nowrap text-black">
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

      {/* 3D Buildings Layer */}
      <Layer
        id="3d-buildings"
        source="openmaptiles"
        source-layer="building"
        type="fill-extrusion"
        minzoom={15}
        paint={{
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            ['get', 'render_height'],
            0, '#f2f2f2',
            50, '#e0e0e0',
            100, '#bdbdbd'
          ],
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-opacity': is3D ? 0.8 : 0
        }}
      />
    </Map>
  );
};

export default function App() {
  const [images, setImages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ pickup: '', pickupHouseNumber: '', dropoff: '', dropoffHouseNumber: '' });
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
  const mapRef = useRef<MapRef>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [totalEarnings, setTotalEarnings] = useState(0);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastUpdateRef = useRef(0);

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
      const [pickupCoords, dropoffCoords] = await Promise.all([
        geocodeAddress(editForm.pickup, editForm.pickupHouseNumber, userLocation),
        geocodeAddress(editForm.dropoff, editForm.dropoffHouseNumber, userLocation)
      ]);

      setOrders(prev => prev.map(o => o.id === id ? { 
        ...o, 
        pickup: editForm.pickup, 
        pickupHouseNumber: editForm.pickupHouseNumber,
        dropoff: editForm.dropoff,
        dropoffHouseNumber: editForm.dropoffHouseNumber,
        pickupCoords: pickupCoords || o.pickupCoords,
        dropoffCoords: dropoffCoords || o.dropoffCoords
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
          // Start processing this image immediately
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
            model: "gemini-3-flash-preview",
            contents: [
              {
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: base64Data } },
                  { text: `Extract delivery info from image. Output ONLY JSON.
                    Rules:
                    1. Format addresses as: [Street Name] [House Number], [City Name].
                    2. ALWAYS include the City Name if visible.
                    3. Expand abbreviations (שד->שדרות, רח->רחוב, ק->קריית).
                    4. Remove noise (איסוף, מסירה, :).
                    5. If a business name is present, include it in pickupBusiness/dropoffBusiness.
                    6. Fields: pickup, pickupHouseNumber, pickupBusiness, dropoff, dropoffHouseNumber, dropoffBusiness, urgency (high/medium/low), estimatedMinutes, distance, payment.` }
                ]
              }
            ],
            config: {
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
                  urgency: { type: Type.STRING, enum: ["high", "medium", "low"] },
                  urgencyText: { type: Type.STRING },
                  estimatedMinutes: { type: Type.NUMBER, nullable: true },
                  distance: { type: Type.STRING, nullable: true },
                  payment: { type: Type.STRING, nullable: true },
                  priorityScore: { type: Type.NUMBER }
                },
                required: ["pickup", "dropoff", "urgency", "urgencyText", "priorityScore"]
              }
            }
          });

          const text = response.text;
          if (!text) return null;

          const result = JSON.parse(text);
          
  const [pickupRes, dropoffRes] = await Promise.all([
            geocodeAddress(result.pickup, result.pickupHouseNumber, userLocation).then(res => 
              res || (result.pickupBusiness ? geocodeAddress(`${result.pickupBusiness}, ${result.pickup.split(',').pop()}`, undefined, userLocation) : null)
            ),
            geocodeAddress(result.dropoff, result.dropoffHouseNumber, userLocation).then(res => 
              res || (result.dropoffBusiness ? geocodeAddress(`${result.dropoffBusiness}, ${result.dropoff.split(',').pop()}`, undefined, userLocation) : null)
            )
          ]);

          return {
            ...result,
            pickup: pickupRes?.display_name || result.pickup,
            dropoff: dropoffRes?.display_name || result.dropoff,
            pickupCoords: pickupRes ? { lat: pickupRes.lat, lng: pickupRes.lng } : undefined,
            dropoffCoords: dropoffRes ? { lat: dropoffRes.lat, lng: dropoffRes.lng } : undefined,
            id: Math.random().toString(36).substr(2, 9),
            timestamp: Date.now(),
            status: 'pending'
          } as DeliveryInfo;
        } catch (err: any) {
          const errString = JSON.stringify(err);
          const isRateLimit = errString.includes('429') || errString.includes('RESOURCE_EXHAUSTED');
          if (isRateLimit && retries < maxRetries) {
            retries++;
            continue;
          }
          return null;
        }
      }
      return null;
    };

    const results = await Promise.all(imagesToProcess.map(img => processSingleImage(img)));
    const validResults = results.filter((r): r is DeliveryInfo => r !== null);
    
    if (validResults.length > 0) {
      setOrders(prev => [...prev, ...validResults]);
      setImages(prev => prev.filter(img => !imagesToProcess.includes(img)));
    }

    setProcessingProgress(prev => {
      const newCurrent = prev.current + imagesToProcess.length;
      if (newCurrent >= prev.total) {
        setIsProcessing(false);
        return { current: 0, total: 0 };
      }
      return { ...prev, current: newCurrent };
    });
  };

  const startSmartRoute = (ordersList?: DeliveryInfo[]) => {
    const list = ordersList || orders;
    const nextOrder = list.find(o => o.status !== 'delivered');
    if (!nextOrder) {
      setViewMode('list');
      stopNavigation();
      return;
    }

    const type = nextOrder.status === 'pending' ? 'pickup' : 'dropoff';
    const targetCoords = type === 'pickup' ? nextOrder.pickupCoords : nextOrder.dropoffCoords;
    
    if (!targetCoords) {
      const addr = type === 'pickup' ? nextOrder.pickup : nextOrder.dropoff;
      setError(`לא נמצאו קואורדינטות לכתובת: ${addr}. נסה להזין כתובת מדויקת יותר.`);
      return;
    }

    setActiveOrderId(nextOrder.id);
    setActiveOrderType(type);
    setActiveDestination(targetCoords);
    setViewMode('map');
  };

  const stopNavigation = () => {
    setActiveDestination(null);
    setActiveOrderId(null);
    setActiveOrderType(null);
  };

  const handleNavigationAction = () => {
    if (!activeOrderId || !activeOrderType) return;
    const newStatus = activeOrderType === 'pickup' ? 'picked_up' : 'delivered';
    const updatedOrders = orders.map(o => o.id === activeOrderId ? { ...o, status: newStatus } : o);
    setOrders(updatedOrders);
    
    const currentOrder = updatedOrders.find(o => o.id === activeOrderId);
    if (activeOrderType === 'dropoff' && currentOrder) {
      const amount = parseFloat((currentOrder.payment || "0").replace(/[^0-9.]/g, '')) || 0;
      setTotalEarnings(prev => prev + amount);
    }
    
    if (activeOrderType === 'pickup' && currentOrder?.dropoffCoords) {
      setActiveOrderType('dropoff');
      setActiveDestination(currentOrder.dropoffCoords);
    } else {
      startSmartRoute(updatedOrders);
    }
  };

  const toggleAutoRotate = async () => {
    if (!isAutoRotate) {
      // @ts-ignore
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          // @ts-ignore
          const permissionState = await DeviceOrientationEvent.requestPermission();
          if (permissionState === 'granted') setIsAutoRotate(true);
          else setError("יש לאשר גישה לחיישני התנועה.");
        } catch (err) { setError("שגיאה בבקשת הרשאה."); }
      } else {
        setIsAutoRotate(true);
      }
    } else {
      setIsAutoRotate(false);
    }
  };

  const getDistance = (p1: { lat: number, lng: number }, p2: { lat: number, lng: number }) => {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lng - p1.lng) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // Auto-sort orders by distance to pickup
  useEffect(() => {
    if (userLocation && orders.length > 0) {
      const sorted = [...orders].sort((a, b) => {
        if (a.status === 'delivered' && b.status !== 'delivered') return 1;
        if (a.status !== 'delivered' && b.status === 'delivered') return -1;
        
        if (a.pickupCoords && b.pickupCoords) {
          const distA = getDistance(userLocation, a.pickupCoords);
          const distB = getDistance(userLocation, b.pickupCoords);
          return distA - distB;
        }
        return 0;
      });
      
      if (JSON.stringify(sorted) !== JSON.stringify(orders)) {
        setOrders(sorted);
      }
    }
  }, [userLocation, orders]);

  useEffect(() => {
    if (!isAutoRotate) {
      setDeviceHeading(null);
      return;
    }
    const handleOrientation = (e: DeviceOrientationEvent) => {
      const now = Date.now();
      if (now - lastUpdateRef.current < 16) return;
      lastUpdateRef.current = now;
      // @ts-ignore
      const heading = e.webkitCompassHeading || (360 - e.alpha);
      if (heading !== undefined && heading !== null) {
        setDeviceHeading(prev => {
          if (prev === null) return heading;
          let diff = heading - prev;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;
          return (prev + diff * 0.15 + 360) % 360;
        });
      }
    };
    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, [isAutoRotate]);

  return (
    <div className="fixed inset-0 bg-slate-50 overflow-hidden" dir="rtl">
      <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" multiple className="hidden" />
      
      <div className="absolute inset-0 z-0 h-full w-full">
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
        />
      </div>

      <header className="absolute top-4 left-4 right-4 z-20 pointer-events-none">
        <div className="max-w-md mx-auto flex items-center justify-between bg-white/80 backdrop-blur-md p-3 rounded-2xl shadow-lg border border-white/50 pointer-events-auto">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center shadow-md">
              <Bike size={20} />
            </div>
            <div>
              <h1 className="text-sm font-black text-slate-900 leading-tight">עוזר משלוחים</h1>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Clean Map Engine</p>
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <div className="flex items-center gap-2 text-green-700 px-3 py-1.5 rounded-xl border border-green-100 bg-green-50/50">
              <motion.span 
                key={totalEarnings}
                initial={{ scale: 1.5, color: '#16a34a' }}
                animate={{ scale: 1, color: '#15803d' }}
                className="text-xs font-black tracking-tight"
              >
                ₪{totalEarnings.toFixed(2)}
              </motion.span>
            </div>
            <button onClick={() => setViewMode(viewMode === 'list' ? 'map' : 'list')} className="p-2.5 bg-slate-100 text-slate-600 rounded-xl">
              {viewMode === 'list' ? <MapIcon size={20} /> : <List size={20} />}
            </button>
          </div>
        </div>
      </header>

      <main className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-end p-4">
        <div className="w-full max-w-md mx-auto space-y-4 pointer-events-auto">
          <AnimatePresence>
            {error && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="bg-red-500 text-white p-4 rounded-2xl shadow-xl flex items-center gap-3">
                <AlertCircle size={18} />
                <p className="text-sm font-bold">{error}</p>
                <button onClick={() => setError(null)} className="mr-auto">×</button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            {viewMode === 'list' ? (
              <motion.div key="list" initial={{ opacity: 0, y: 100 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 100 }} className="glass-card max-h-[70vh] flex flex-col overflow-hidden">
                <div className="p-4 border-b flex items-center justify-between bg-white/50 backdrop-blur-sm sticky top-0 z-10">
                  <h2 className="font-black text-slate-800">תור עבודה ({orders.length})</h2>
                  {orders.length > 0 && (
                    <button onClick={() => setShowClearConfirm(true)} className="text-red-500 p-2 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-24">
                  <div onClick={() => fileInputRef.current?.click()} className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl p-6 text-center cursor-pointer hover:bg-slate-100 transition-colors">
                    <Upload className="mx-auto mb-2 text-slate-400" />
                    <p className="text-xs font-bold text-slate-700">העלה צילומי מסך של הזמנות</p>
                  </div>
                  
                  {orders.length > 0 && orders.some(o => o.status !== 'delivered') && (
                    <button 
                      onClick={() => startSmartRoute()} 
                      className="w-full py-4 bg-green-600 text-white rounded-2xl font-black shadow-lg shadow-green-200 flex items-center justify-center gap-3"
                    >
                      <Navigation2 size={20} />
                      התחל מסלול חכם
                    </button>
                  )}

                  {images.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
                        {images.map((img, idx) => (
                          <motion.div 
                            key={idx}
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="relative flex-shrink-0 w-20 h-20 rounded-xl overflow-hidden border-2 border-white shadow-sm"
                          >
                            <img src={img} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            <button 
                              onClick={() => setImages(prev => prev.filter((_, i) => i !== idx))}
                              className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] shadow-md"
                            >
                              ×
                            </button>
                          </motion.div>
                        ))}
                      </div>
                      
                      <button 
                        onClick={() => processImages(images)} 
                        disabled={isProcessing} 
                        className="relative w-full py-4 bg-blue-600 text-white rounded-2xl font-black shadow-lg shadow-blue-200 overflow-hidden group"
                      >
                        {isProcessing && (
                          <motion.div 
                            className="absolute inset-0 bg-blue-400/30 origin-left"
                            initial={{ scaleX: 0 }}
                            animate={{ scaleX: processingProgress.total > 0 ? processingProgress.current / processingProgress.total : 0 }}
                            transition={{ type: "spring", bounce: 0, duration: 0.5 }}
                          />
                        )}
                        <span className="relative z-10 flex items-center justify-center gap-2">
                          {isProcessing ? (
                            <>
                              <motion.div 
                                animate={{ rotate: 360 }} 
                                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                              >
                                <RefreshCw size={18} />
                              </motion.div>
                              מעבד {processingProgress.current}/{processingProgress.total}...
                            </>
                          ) : (
                            <>
                              נתח {images.length} תמונות
                            </>
                          )}
                        </span>
                      </button>
                    </div>
                  )}
                  {orders.map(order => (
                    <div key={order.id} className={`p-4 rounded-2xl border bg-white ${order.status === 'delivered' ? 'opacity-50' : ''}`}>
                      <div className="flex justify-between mb-2">
                        <span className="text-[10px] font-black bg-blue-50 text-blue-600 px-2 py-0.5 rounded uppercase">{order.urgencyText}</span>
                        <button onClick={() => setOrders(prev => prev.filter(o => o.id !== order.id))} className="text-slate-300"><Trash2 size={14} /></button>
                      </div>
                      {editingOrderId === order.id ? (
                        <div className="space-y-2 mb-3 relative">
                          <div className="flex gap-1">
                            <div className="relative flex-1">
                              <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                                <MapPin size={14} className="text-slate-400" />
                              </div>
                              <input 
                                value={editForm.pickup} 
                                onFocus={() => setSuggestions(prev => ({ ...prev, type: 'pickup' }))}
                                onChange={e => setEditForm(prev => ({ ...prev, pickup: e.target.value }))}
                                className="w-full p-2 pr-8 text-xs border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="רחוב איסוף"
                              />
                            </div>
                            <input 
                              value={editForm.pickupHouseNumber} 
                              onChange={e => setEditForm(prev => ({ ...prev, pickupHouseNumber: e.target.value }))}
                              className="w-12 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-center"
                              placeholder="מס'"
                            />
                            <button onClick={() => manualSearch('pickup')} className="p-2 bg-blue-50 text-blue-600 rounded-lg"><Search size={14} /></button>
                          </div>
                          {suggestions.type === 'pickup' && suggestions.list.length > 0 && (
                            <div className="absolute top-10 left-0 right-16 bg-white border rounded-lg shadow-xl z-50 mt-1 max-h-40 overflow-y-auto">
                              {suggestions.list.map((s, i) => (
                                <div 
                                  key={i} 
                                  onClick={() => { setEditForm(prev => ({ ...prev, pickup: s.display_name })); setSuggestions(prev => ({ ...prev, list: [] })); }}
                                  className="p-2 text-[10px] hover:bg-slate-50 cursor-pointer border-b last:border-0 flex items-center gap-2"
                                >
                                  <MapPin size={10} className="text-blue-500" />
                                  <span className="truncate">{s.display_name}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex gap-1">
                            <div className="relative flex-1">
                              <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                                <MapPin size={14} className="text-slate-400" />
                              </div>
                              <input 
                                value={editForm.dropoff} 
                                onFocus={() => setSuggestions(prev => ({ ...prev, type: 'dropoff' }))}
                                onChange={e => setEditForm(prev => ({ ...prev, dropoff: e.target.value }))}
                                className="w-full p-2 pr-8 text-xs border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="רחוב מסירה"
                              />
                            </div>
                            <input 
                              value={editForm.dropoffHouseNumber} 
                              onChange={e => setEditForm(prev => ({ ...prev, dropoffHouseNumber: e.target.value }))}
                              className="w-12 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-center"
                              placeholder="מס'"
                            />
                            <button onClick={() => manualSearch('dropoff')} className="p-2 bg-blue-50 text-blue-600 rounded-lg"><Search size={14} /></button>
                          </div>
                          {suggestions.type === 'dropoff' && suggestions.list.length > 0 && (
                            <div className="absolute top-20 left-0 right-16 bg-white border rounded-lg shadow-xl z-50 mt-1 max-h-40 overflow-y-auto">
                              {suggestions.list.map((s, i) => (
                                <div 
                                  key={i} 
                                  onClick={() => { setEditForm(prev => ({ ...prev, dropoff: s.display_name })); setSuggestions(prev => ({ ...prev, list: [] })); }}
                                  className="p-2 text-[10px] hover:bg-slate-50 cursor-pointer border-b last:border-0 flex items-center gap-2"
                                >
                                  <MapPin size={10} className="text-blue-500" />
                                  <span className="truncate">{s.display_name}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex gap-2 pt-2">
                            <button onClick={() => saveEditedOrder(order.id)} className="flex-1 py-2 bg-green-600 text-white rounded-lg text-[10px] font-bold">שמור</button>
                            <button onClick={() => { setEditingOrderId(null); setSuggestions({ type: 'pickup', list: [] }); }} className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold">ביטול</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs font-bold mb-1 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                            איסוף: {order.pickup} {order.pickupHouseNumber}
                          </p>
                          <p className="text-xs font-bold mb-3 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                            מסירה: {order.dropoff} {order.dropoffHouseNumber}
                          </p>
                          {(!order.pickupCoords || !order.dropoffCoords) && (
                            <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3 flex items-center gap-3">
                              <div className="bg-red-100 p-2 rounded-full text-red-600">
                                <AlertCircle size={18} />
                              </div>
                              <div className="flex-1">
                                <p className="text-[11px] font-black text-red-700 leading-tight">כתובת לא נמצאה במפה</p>
                                <p className="text-[9px] text-red-600">לחץ על העיפרון כדי לתקן את הכתובת ידנית</p>
                              </div>
                            </div>
                          )}
                          <div className="flex gap-2">
                            <button 
                              onClick={() => { 
                                if (order.pickupCoords) {
                                  setActiveOrderId(order.id); 
                                  setActiveOrderType('pickup'); 
                                  setActiveDestination(order.pickupCoords); 
                                  setViewMode('map'); 
                                }
                              }} 
                              disabled={!order.pickupCoords}
                              className={`flex-1 py-2 rounded-lg text-[10px] font-bold transition-colors ${order.pickupCoords ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
                            >
                              ניווט לאיסוף
                            </button>
                            <button 
                              onClick={() => { 
                                if (order.dropoffCoords) {
                                  setActiveOrderId(order.id); 
                                  setActiveOrderType('dropoff'); 
                                  setActiveDestination(order.dropoffCoords); 
                                  setViewMode('map'); 
                                }
                              }} 
                              disabled={!order.dropoffCoords}
                              className={`flex-1 py-2 rounded-lg text-[10px] font-bold transition-colors ${order.dropoffCoords ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
                            >
                              ניווט למסירה
                            </button>
                            <button 
                              onClick={() => { 
                                setEditingOrderId(order.id); 
                                setEditForm({ 
                                  pickup: order.pickup || '', 
                                  pickupHouseNumber: order.pickupHouseNumber || '', 
                                  dropoff: order.dropoff || '', 
                                  dropoffHouseNumber: order.dropoffHouseNumber || '' 
                                }); 
                              }} 
                              className="p-2 bg-slate-100 text-slate-600 rounded-lg flex items-center gap-1"
                              title="ערוך טקסט"
                            >
                              <Edit3 size={14} />
                              <span className="text-[8px] font-bold">ערוך</span>
                            </button>
                            <button 
                              onClick={() => { 
                                setEditingOrderId(order.id); 
                                setEditForm({ 
                                  pickup: order.pickup || '', 
                                  pickupHouseNumber: order.pickupHouseNumber || '', 
                                  dropoff: order.dropoff || '', 
                                  dropoffHouseNumber: order.dropoffHouseNumber || '' 
                                }); 
                              }} 
                              className="p-2 bg-slate-100 text-slate-600 rounded-lg"
                            >
                              <MapPin size={14} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div key="map" initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className="flex flex-col gap-4">
                {activeDestination && (
                  <button 
                    onClick={handleNavigationAction} 
                    className={`w-full py-6 text-white rounded-3xl font-black text-2xl shadow-2xl flex items-center justify-center gap-4 active:scale-95 transition-all ${activeOrderType === 'pickup' ? 'bg-green-600' : 'bg-blue-600'}`}
                  >
                    <CheckCircle2 size={32} />
                    {activeOrderType === 'pickup' ? 'אספתי הזמנה' : 'מסרתי הזמנה'}
                  </button>
                )}
                <div className="flex gap-3">
                  <button 
                    onClick={() => {
                      if (userLocation) {
                        setIsAutoRotate(!isAutoRotate);
                        if (!isAutoRotate) {
                          // Trigger permission request if needed
                          toggleAutoRotate();
                        }
                      }
                    }} 
                    className={`flex-[2] py-3.5 rounded-xl font-bold text-xs shadow-md transition-all flex items-center justify-center gap-2 ${isAutoRotate ? 'bg-blue-600 text-white' : 'bg-white/90 backdrop-blur-sm text-slate-600 border border-slate-200/50'}`}
                  >
                    <Navigation size={14} className={isAutoRotate ? 'animate-pulse' : ''} />
                    {isAutoRotate ? 'מעקב פעיל' : 'הפעל מעקב'}
                  </button>
                  <button 
                    onClick={() => setIs3D(!is3D)}
                    className={`flex-1 py-3.5 rounded-xl font-bold text-xs shadow-md transition-all flex items-center justify-center ${is3D ? 'bg-blue-600 text-white' : 'bg-white/90 backdrop-blur-sm text-slate-600 border border-slate-200/50'}`}
                  >
                    3D
                  </button>
                  <button onClick={() => setShowClearConfirm(true)} className="flex-1 py-3.5 bg-white/90 backdrop-blur-sm text-red-500 border border-red-100/50 rounded-xl font-bold text-xs shadow-md">מחק</button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <AnimatePresence>
        {showClearConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm pointer-events-auto">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-white p-6 rounded-3xl max-w-xs w-full text-center">
              <h3 className="font-black text-lg mb-2">למחוק את כל ההזמנות?</h3>
              <p className="text-sm text-slate-500 mb-6">פעולה זו תנקה את כל תור העבודה שלך.</p>
              <div className="flex gap-3">
                <button onClick={() => { setOrders([]); setImages([]); stopNavigation(); setShowClearConfirm(false); }} className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold">כן, מחק</button>
                <button onClick={() => setShowClearConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-bold">ביטול</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .glass-card { background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(16px); border-radius: 24px; }
      `}</style>
    </div>
  );
}
