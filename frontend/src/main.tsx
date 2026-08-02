import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './context/AuthContext.tsx'
import { GithubSessionProvider } from './context/GithubSessionContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GithubSessionProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </GithubSessionProvider>
  </StrictMode>,
)
