import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import '../App.css'
import './replay.css'
import Replay from './Replay.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Replay />
  </StrictMode>,
)
