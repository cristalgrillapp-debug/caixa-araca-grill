import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import PaginaReservas from './Reservas.jsx'

const path = window.location.pathname
const isReservas = path === '/reservar' || path.startsWith('/reservar')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isReservas ? <PaginaReservas /> : <App />}
  </React.StrictMode>
)
