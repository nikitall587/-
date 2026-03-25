/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
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
  Sparkles,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MapContainer, 
  TileLayer, 
  Marker as LeafletMarker, 
  useMap,
  Polyline
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet-routing-machine';

// Fix Leaflet marker icons
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const userIcon = L.divIcon({
  className: 'user-location-marker',
  html: '<div class="w-4 h-4 bg-blue-600 rounded-full border-2 border-white shadow-lg"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

const pickupIcon = L.divIcon({
  className: 'pickup-marker',
  html: '<div class="w-8 h-8 bg-green-600 text-white rounded-full flex items-center justify-center font-black text-xs shadow-lg border-2 border-white">P</div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16]
});

const dropoffIcon = L.divIcon({
  className: 'dropoff-marker',
  html: '<div class="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-xs shadow-lg border-2 border-white">D</div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16]
});

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface DeliveryInfo {
  id: string;
  pickup: string;
  dropoff: string;
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
const geocodeAddress = async (address: string, userLoc?: { lat: number, lng: number } | null): Promise<{ lat: number, lng: number, display_name?: string } | null> => {
  if (!address) return null;
  
  const cleanHebrewAddress = (addr: string) => {
    return addr
      .replace(/(רחוב|רח'|רח׳|בנין|בניין|דירה|קומה|כניסה|בית)\s+\d*[א-ת0-9]*/g, '')
      .replace(/(רחוב|רח'|רח׳|בנין|בניין|דירה|קומה|כניסה|בית)/g, '')
      .replace(/["']/g, '') // Normalize acronyms (צה"ל -> צהל)
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const tryGeocode = async (query: string | Record<string, string>) => {
    try {
      let url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=il&addressdetails=1';
      
      if (userLoc) {
        const viewboxSize = 0.5;
        const viewbox = `${userLoc.lng - viewboxSize},${userLoc.lat + viewboxSize},${userLoc.lng + viewboxSize},${userLoc.lat - viewboxSize}`;
        url += `&viewbox=${viewbox}`;
      }

      if (typeof query === 'string') {
        url += `&q=${encodeURIComponent(query)}`;
      } else {
        Object.entries(query).forEach(([key, val]) => {
          url += `&${key}=${encodeURIComponent(val)}`;
        });
      }

      const response = await fetch(url, {
        headers: { 'Accept-Language': 'he,en', 'User-Agent': 'DeliveryAssistantApp/1.0' }
      });
      
      if (!response.ok) return null;
      const data = await response.json();
      if (data && data.length > 0) {
        const addr = data[0].address;
        const cleanName = addr.road ? `${addr.road}${addr.house_number ? ' ' + addr.house_number : ''}, ${addr.city || addr.town || addr.village || ''}` : data[0].display_name;
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display_name: cleanName };
      }
      return null;
    } catch (err) {
      return null;
    }
  };

  const cleaned = cleanHebrewAddress(address);
  
  // Strategy 1: Full Cleaned Address
  let result = await tryGeocode(cleaned);
  if (result) return result;

  // Strategy 2: Handle "ה" and Word Swapping (e.g., המלך שלמה vs שלמה המלך)
  const parts = cleaned.split(/[,/-]/).map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length >= 1) {
    const streetPart = parts[0];
    const cityPart = parts.length > 1 ? parts[parts.length - 1] : '';
    
    // Try swapping words if "המלך" or "הנביא" etc is present
    const words = streetPart.split(' ');
    if (words.length >= 2) {
      const swapped = [...words].reverse().join(' ');
      result = await tryGeocode(cityPart ? `${swapped}, ${cityPart}` : swapped);
      if (result) return result;
    }

    // Try adding/removing "ה" prefix
    const withH = streetPart.startsWith('ה') ? streetPart.substring(1) : 'ה' + streetPart;
    result = await tryGeocode(cityPart ? `${withH}, ${cityPart}` : withH);
    if (result) return result;
  }

  // Strategy 3: Fallback - Street + Number ONLY (No City)
  if (parts.length >= 2) {
    const streetAndNumber = parts[0];
    result = await tryGeocode(streetAndNumber);
    if (result) return result;
  }

  return null;
};

const getAddressSuggestions = async (query: string, userLoc?: { lat: number, lng: number } | null): Promise<any[]> => {
  if (query.length < 2) return [];
  try {
    let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&countrycodes=il&addressdetails=1`;
    
    if (userLoc) {
      const viewboxSize = 0.2; // ~20km for tighter suggestions
      const viewbox = `${userLoc.lng - viewboxSize},${userLoc.lat + viewboxSize},${userLoc.lng + viewboxSize},${userLoc.lat - viewboxSize}`;
      url += `&viewbox=${viewbox}`;
    }

    const response = await fetch(url, {
      headers: { 'Accept-Language': 'he,en', 'User-Agent': 'DeliveryAssistantApp/1.0' }
    });
    
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    return [];
  }
};

const Routing = ({ origin, destination }: { origin: { lat: number, lng: number }, destination: { lat: number, lng: number } }) => {
  const map = useMap();

  useEffect(() => {
    if (!map || !origin || !destination) return;

    // @ts-ignore
    const routingControl = L.Routing.control({
      waypoints: [
        L.latLng(origin.lat, origin.lng),
        L.latLng(destination.lat, destination.lng)
      ],
      routeWhileDragging: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: true,
      show: false, // Hide instructions panel
      createMarker: () => null, // Don't add markers, we handle them manually
      lineOptions: {
        styles: [{ color: '#2563eb', weight: 6, opacity: 0.8 }],
        extendToWaypoints: false,
        missingRouteTolerance: 0
      },
      // @ts-ignore
      router: L.Routing.osrmv1({
        serviceUrl: 'https://router.project-osrm.org/route/v1'
      })
    } as any).addTo(map);

    return () => {
      if (map && routingControl) {
        try {
          // Use a safer way to remove the control
          map.removeControl(routingControl);
        } catch (e) {
          // Ignore errors during unmount/cleanup
        }
      }
    };
  }, [map, origin, destination]);

  return null;
};

const MapController = ({ center }: { center: { lat: number, lng: number } | null }) => {
  const map = useMap();
  useEffect(() => {
    if (center && map && typeof map.setView === 'function') {
      map.setView([center.lat, center.lng], map.getZoom());
    }
  }, [center, map]);
  return null;
};

export default function App() {
  const [images, setImages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ pickup: '', dropoff: '' });
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

  const saveEditedOrder = async (id: string) => {
    const order = orders.find(o => o.id === id);
    if (!order) return;

    setIsProcessing(true);
    try {
      const [pickupCoords, dropoffCoords] = await Promise.all([
        geocodeAddress(editForm.pickup, userLocation),
        geocodeAddress(editForm.dropoff, userLocation)
      ]);

      setOrders(prev => prev.map(o => o.id === id ? { 
        ...o, 
        pickup: editForm.pickup, 
        dropoff: editForm.dropoff,
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
      const newImages: string[] = [];
      let loadedCount = 0;
      Array.from(files).forEach((file: File) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          newImages.push(reader.result as string);
          loadedCount++;
          if (loadedCount === files.length) {
            setImages(prev => [...prev, ...newImages]);
            setError(null);
          }
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const processAllImages = async () => {
    const imagesToProcess = [...images];
    if (imagesToProcess.length === 0) return;

    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: imagesToProcess.length });
    setError(null);

    const processSingleImage = async (imgData: string) => {
      let retries = 0;
      const maxRetries = 5;
      const baseDelay = 500; // Reduced base delay for first attempt

      while (retries <= maxRetries) {
        try {
          // Exponential backoff only if we hit a rate limit
          if (retries > 0) {
            const delay = 2000 * Math.pow(2, retries - 1);
            console.log(`Rate limit hit. Waiting ${delay}ms before retry ${retries}...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            // Small initial stagger to avoid simultaneous bursts
            await new Promise(resolve => setTimeout(resolve, Math.random() * 500));
          }
          
          const base64Data = imgData.split(',')[1];
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [
              {
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: base64Data } },
                  { text: `Analyze this delivery order screenshot from a delivery app. This is for a BICYCLE delivery assistant.
                    
                    Specific instructions for extraction:
                    1. **Pickup Address**: Look for "כתובת איסוף" or the starting point. Extract Street, Number, and City.
                    2. **Pickup Business**: If there's a business name at the pickup (e.g., "פיצה שמש", "סופר פארם"), extract it.
                    3. **Dropoff Address**: Look for "כתובת מסירה" or the destination. Extract Street, Number, and City.
                    4. **Dropoff Business**: If there's a business name at the dropoff, extract it.
                    5. **Urgency**: 
                       - If it says "איסוף הזמנה עכשיו" or "עכשיו", urgency is "high" (Score 90-100).
                       - If it says "איסוף בעוד X דק'", extract X as estimatedMinutes and set urgency to "medium" (Score 60-80).
                    6. **Distance**: Look for "מרחק" (e.g., "0.79 ק\"מ").
                    7. **Payment**: Look for "הערכת תשלום" or the price in ₪.
                    
                    All text fields should be in Hebrew as they appear in the image.` }
                ]
              }
            ],
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  pickup: { type: Type.STRING },
                  pickupBusiness: { type: Type.STRING, nullable: true },
                  dropoff: { type: Type.STRING },
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
          
          // Try geocoding with address first, then fallback to business name + city
          const [pickupRes, dropoffRes] = await Promise.all([
            geocodeAddress(result.pickup, userLocation).then(res => 
              res || (result.pickupBusiness ? geocodeAddress(`${result.pickupBusiness}, ${result.pickup.split(',').pop()}`, userLocation) : null)
            ),
            geocodeAddress(result.dropoff, userLocation).then(res => 
              res || (result.dropoffBusiness ? geocodeAddress(`${result.dropoffBusiness}, ${result.dropoff.split(',').pop()}`, userLocation) : null)
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
          const isRateLimit = errString.includes('429') || errString.includes('RESOURCE_EXHAUSTED') || 
                             err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
          
          if (isRateLimit && retries < maxRetries) {
            retries++;
            continue;
          }
          
          if (isRateLimit) {
            setError("חרגת ממכסת השימוש ב-AI. אנא המתן דקה ונסה שוב.");
          } else {
            console.error("Error processing single image:", err);
          }
          return null;
        }
      }
      return null;
    };

    try {
      const validOrders: DeliveryInfo[] = [];
      const concurrencyLimit = 2; // Process 2 images at a time
      
      for (let i = 0; i < imagesToProcess.length; i += concurrencyLimit) {
        const chunk = imagesToProcess.slice(i, i + concurrencyLimit);
        const results = await Promise.all(chunk.map(async (img, index) => {
          const order = await processSingleImage(img);
          setProcessingProgress(prev => ({ ...prev, current: prev.current + 1 }));
          return order;
        }));
        
        results.forEach(order => {
          if (order) validOrders.push(order);
        });
      }

      if (validOrders.length > 0) {
        setOrders(prev => {
          const updated = [...prev, ...validOrders].sort((a, b) => b.priorityScore - a.priorityScore);
          return updated;
        });
        setImages(prev => prev.filter(img => !imagesToProcess.includes(img)));
      }
    } catch (err) {
      setError("אירעה שגיאה בעיבוד התמונות");
    } finally {
      setIsProcessing(false);
    }
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
    <div className="fixed inset-0 bg-slate-50 overflow-hidden flex flex-col md:flex-row" dir="rtl">
      <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" multiple className="hidden" />
      
      <div className="absolute inset-0 z-0">
        <MapContainer
          center={userLocation || { lat: 32.0853, lng: 34.7818 }}
          zoom={13}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
          attributionControl={false}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          />
          
          <MapController center={userLocation} />

          {userLocation && (
            <LeafletMarker position={[userLocation.lat, userLocation.lng]} icon={userIcon} />
          )}

          {userLocation && activeDestination && (
            <Routing origin={userLocation} destination={activeDestination} />
          )}

          {orders.filter(o => o.status !== 'delivered').map(order => (
            <React.Fragment key={order.id}>
              {order.pickupCoords && order.status === 'pending' && (
                <LeafletMarker 
                  position={[order.pickupCoords.lat, order.pickupCoords.lng]} 
                  icon={pickupIcon}
                />
              )}
              {order.dropoffCoords && (
                <LeafletMarker 
                  position={[order.dropoffCoords.lat, order.dropoffCoords.lng]} 
                  icon={dropoffIcon}
                />
              )}
            </React.Fragment>
          ))}
        </MapContainer>
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
              <span className="text-xs font-black tracking-tight">₪{totalEarnings.toFixed(2)}</span>
            </div>
            <button onClick={() => setViewMode(viewMode === 'list' ? 'map' : 'list')} className="p-2.5 bg-slate-100 text-slate-600 rounded-xl">
              {viewMode === 'list' ? <MapIcon size={20} /> : <List size={20} />}
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 pointer-events-none flex flex-col justify-end p-4">
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
                        onClick={processAllImages} 
                        disabled={isProcessing} 
                        className="relative w-full py-4 bg-blue-600 text-white rounded-2xl font-black shadow-lg shadow-blue-200 overflow-hidden group"
                      >
                        {isProcessing && (
                          <motion.div 
                            className="absolute inset-0 bg-blue-400/30 origin-left"
                            initial={{ scaleX: 0 }}
                            animate={{ scaleX: processingProgress.current / processingProgress.total }}
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
                          <div className="relative">
                            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                              <MapPin size={14} className="text-slate-400" />
                            </div>
                            <input 
                              value={editForm.pickup} 
                              onFocus={() => setSuggestions(prev => ({ ...prev, type: 'pickup' }))}
                              onChange={e => setEditForm(prev => ({ ...prev, pickup: e.target.value }))}
                              className="w-full p-2 pr-8 text-xs border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                              placeholder="כתובת איסוף"
                            />
                            {suggestions.type === 'pickup' && suggestions.list.length > 0 && (
                              <div className="absolute top-full left-0 right-0 bg-white border rounded-lg shadow-xl z-50 mt-1 max-h-40 overflow-y-auto">
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
                          </div>

                          <div className="relative">
                            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                              <MapPin size={14} className="text-slate-400" />
                            </div>
                            <input 
                              value={editForm.dropoff} 
                              onFocus={() => setSuggestions(prev => ({ ...prev, type: 'dropoff' }))}
                              onChange={e => setEditForm(prev => ({ ...prev, dropoff: e.target.value }))}
                              className="w-full p-2 pr-8 text-xs border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                              placeholder="כתובת מסירה"
                            />
                            {suggestions.type === 'dropoff' && suggestions.list.length > 0 && (
                              <div className="absolute top-full left-0 right-0 bg-white border rounded-lg shadow-xl z-50 mt-1 max-h-40 overflow-y-auto">
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
                          </div>

                          <div className="flex gap-2 pt-2">
                            <button onClick={() => saveEditedOrder(order.id)} className="flex-1 py-2 bg-green-600 text-white rounded-lg text-[10px] font-bold">שמור</button>
                            <button onClick={() => { setEditingOrderId(null); setSuggestions({ type: 'pickup', list: [] }); }} className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold">ביטול</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs font-bold mb-1 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                            איסוף: {order.pickup}
                          </p>
                          <p className="text-xs font-bold mb-3 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                            מסירה: {order.dropoff}
                          </p>
                          {(!order.pickupCoords || !order.dropoffCoords) && (
                            <p className="text-[10px] text-red-500 font-bold mb-2">⚠️ כתובת לא נמצאה במפה - לחץ על עריכה</p>
                          )}
                          <div className="flex gap-2">
                            <button onClick={() => { setActiveOrderId(order.id); setActiveOrderType('pickup'); setActiveDestination(order.pickupCoords || null); setViewMode('map'); }} className="flex-1 py-2 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-bold">ניווט לאיסוף</button>
                            <button onClick={() => { setActiveOrderId(order.id); setActiveOrderType('dropoff'); setActiveDestination(order.dropoffCoords || null); setViewMode('map'); }} className="flex-1 py-2 bg-slate-900 text-white rounded-lg text-[10px] font-bold">ניווט למסירה</button>
                            <button onClick={() => { setEditingOrderId(order.id); setEditForm({ pickup: order.pickup, dropoff: order.dropoff }); }} className="p-2 bg-slate-100 text-slate-600 rounded-lg"><MapPin size={14} /></button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div key="map" initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className="flex flex-col gap-3">
                {activeDestination && (
                  <button onClick={handleNavigationAction} className={`w-full py-4 text-white rounded-2xl font-black text-xl shadow-xl flex items-center justify-center gap-3 ${activeOrderType === 'pickup' ? 'bg-green-600' : 'bg-blue-600'}`}>
                    {activeOrderType === 'pickup' ? 'אספתי הזמנה' : 'מסרתי הזמנה'}
                  </button>
                )}
                <div className="flex gap-2">
                  <button onClick={toggleAutoRotate} className={`flex-1 py-3 rounded-xl font-bold text-xs shadow-lg ${isAutoRotate ? 'bg-blue-600 text-white' : 'bg-white text-slate-600'}`}>
                    {isAutoRotate ? 'מעקב 3D פעיל' : 'מעקב 3D כבוי'}
                  </button>
                  <button onClick={() => setShowClearConfirm(true)} className="flex-1 py-3 bg-white text-red-500 rounded-xl font-bold text-xs shadow-lg">מחק הכל</button>
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
