# SignaBanner

Panel de gestión de banners dinámicos para firmas de email O365.

## Stack
- Frontend: HTML/CSS/JS estático (este repo → Netlify)
- Backend: Supabase Edge Functions
- Base de datos: Supabase PostgreSQL (schema `signabanner`)
- Storage: Supabase Storage (bucket `signabanner-banners`)

## Funcionalidades
- Gestión de clientes y departamentos
- Campañas con programación por fechas
- Tracking de cargas y clics por empleado
- Analítica en tiempo real
- Generador de snippet HTML para Outlook

## Deploy
Conectar este repo a Netlify. No requiere build step.
Publish directory: `.` (raíz)
