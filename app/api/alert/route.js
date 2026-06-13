import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// ─── Supabase client (server-side only, usa service_role key) ─────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Validar credenciales ─────────────────────────────────────────────
const whatsappOk =
    process.env.WHATSAPP_TOKEN &&
    process.env.PHONE_NUMBER_ID &&
    process.env.RECIPIENT_PHONE &&
    !process.env.WHATSAPP_TOKEN.startsWith('PEGA_');

// ─── Subir imagen a Supabase Storage ─────────────────────────────────
async function subirImagen(buffer, filename) {
    const { error } = await supabase.storage
        .from('alert-images')
        .upload(filename, buffer, {
            contentType: 'image/jpeg',
            upsert: false,
        });

    if (error) throw new Error('Supabase Storage error: ' + error.message);

    // Obtener URL pública (el bucket debe ser público)
    const { data } = supabase.storage
        .from('alert-images')
        .getPublicUrl(filename);

    return data.publicUrl;
}

// ─── Guardar alerta en Supabase DB ───────────────────────────────────
async function guardarAlerta(imageUrl, imagePath, alertData) {
    const { error } = await supabase
        .from('alerts')
        .insert({ image_url: imageUrl, image_path: imagePath, data: alertData });

    if (error) throw new Error('Supabase DB error: ' + error.message);
}

// ─── Enviar WhatsApp vía Meta Cloud API ──────────────────────────────
async function enviarWhatsApp(imageUrl, timestamp) {
    const fecha = new Date(timestamp).toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City',
        dateStyle: 'short',
        timeStyle: 'medium',
    });

    await axios.post(
        `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to: process.env.RECIPIENT_PHONE,
            type: 'image',
            image: {
                link: imageUrl,
                caption: `🚨 *¡Movimiento detectado!*\n📅 ${fecha}\n📷 Imagen capturada por ESP32-CAM`,
            },
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            timeout: 8000,
        }
    );
}

// ─── POST /api/alert ──────────────────────────────────────────────────
export async function POST(request) {
    try {
        // Parsear multipart/form-data en memoria (sin disco, compatible Vercel)
        const formData = await request.formData();
        const foto     = formData.get('foto');     // File | null
        const alerta   = formData.get('alerta');   // "1"

        if (!foto || typeof foto === 'string') {
            return Response.json({ error: 'No se recibió foto' }, { status: 400 });
        }

        const timestamp = new Date().toISOString();
        const filename  = `alerta-${Date.now()}.jpg`;
        const buffer    = Buffer.from(await foto.arrayBuffer());

        console.log(`📩 Alerta recibida | ${timestamp} | foto: ${buffer.length} bytes`);

        // 1. Subir imagen a Supabase Storage
        let imageUrl = null;
        try {
            imageUrl = await subirImagen(buffer, filename);
            console.log('   ✅ Imagen en Supabase:', imageUrl);
        } catch (err) {
            console.error('   ❌ Error subiendo imagen:', err.message);
        }

        // 2. Guardar registro en Supabase DB
        try {
            await guardarAlerta(imageUrl, filename, { alerta, bytes: buffer.length });
            console.log('   ✅ Registro guardado en DB');
        } catch (err) {
            console.error('   ❌ Error guardando en DB:', err.message);
        }

        // 3. Enviar WhatsApp (si está configurado y hay imagen)
        if (whatsappOk && imageUrl) {
            try {
                await enviarWhatsApp(imageUrl, timestamp);
                console.log('   ✅ WhatsApp enviado');
            } catch (err) {
                console.error('   ❌ Error WhatsApp:', err.response?.data || err.message);
            }
        } else if (!whatsappOk) {
            console.warn('   ⚠️  WhatsApp no configurado (revisa .env.local)');
        }

        return Response.json({ message: 'Alerta y foto guardadas exitosamente' }, { status: 200 });

    } catch (err) {
        console.error('❌ Error general en /api/alert:', err.message);
        return Response.json({ error: 'Error interno del servidor' }, { status: 500 });
    }
}

// ─── GET /api/alert — últimas 50 alertas ─────────────────────────────
export async function GET() {
    const { data, error } = await supabase
        .from('alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json(data, { status: 200 });
}
