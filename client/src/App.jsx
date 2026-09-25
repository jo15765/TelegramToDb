import { useState, useEffect, useCallback } from 'react'
import './App.css'

const API = '/api'

function App() {
  const [phone, setPhone] = useState('')
  const [sportsTypes, setSportsTypes] = useState([])
  const [selectedSports, setSelectedSports] = useState([])
  const [teamsBySport, setTeamsBySport] = useState({})
  const [loading, setLoading] = useState(true)
  const [teamsLoading, setTeamsLoading] = useState({})
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    fetch(API + '/sports-types')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (res.ok) return data
        throw new Error(data.error || (res.status === 503 ? 'Database not configured' : 'Failed to load'))
      })
      .then((list) => {
        setSportsTypes(list || [])
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  const loadTeams = useCallback(async (sport) => {
    if (teamsBySport[sport]?.list) return
    setTeamsLoading((prev) => ({ ...prev, [sport]: true }))
    try {
      const res = await fetch(API + '/teams?sportsType=' + encodeURIComponent(sport))
      const list = await res.json()
      setTeamsBySport((prev) => ({
        ...prev,
        [sport]: { list: list || [], selected: prev[sport]?.selected || [] },
      }))
    } finally {
      setTeamsLoading((prev) => ({ ...prev, [sport]: false }))
    }
  }, [teamsBySport])

  const toggleSport = (sport) => {
    const next = selectedSports.includes(sport)
      ? selectedSports.filter((s) => s !== sport)
      : [...selectedSports, sport].sort()
    setSelectedSports(next)
    next.forEach(loadTeams)
    if (!next.includes(sport)) {
      setTeamsBySport((prev) => {
        const u = { ...prev }
        delete u[sport]
        return u
      })
    }
  }

  const toggleTeam = (sport, team) => {
    const current = teamsBySport[sport]?.selected || []
    const next = current.includes(team) ? current.filter((t) => t !== team) : [...current, team].sort()
    setTeamsBySport((prev) => ({
      ...prev,
      [sport]: { ...(prev[sport] || {}), list: prev[sport]?.list || [], selected: next },
    }))
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    setError('')
    setSaved(false)
    const phoneNorm = phone.replace(/\D/g, '')
    if (phoneNorm.length < 10) {
      setError('Enter a valid phone number (at least 10 digits).')
      return
    }
    const teamFilters = {}
    selectedSports.forEach((sport) => {
      const sel = teamsBySport[sport]?.selected
      if (sel?.length) teamFilters[sport] = sel
    })
    fetch(API + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phoneNorm,
        sportTypes: selectedSports,
        teamFilters,
      }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ok) setSaved(true)
        else setError(data.error || 'Subscribe failed')
      })
      .catch((e) => setError(e.message))
  }

  if (loading) {
    return (
      <div className="app">
        <div className="loader" />
        <p className="muted">Loading sports…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Sports Notifications</h1>
        <p className="tagline">Choose sports and teams to get text alerts for upcoming games.</p>
      </header>

      <main className="main">
        <form onSubmit={handleSubmit} className="card form-card">
          <label className="field">
            <span>Phone number</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              autoComplete="tel"
            />
          </label>

          <div className="field">
            <span>Sports to follow (select at least one)</span>
            <div className="sport-chips">
              {sportsTypes.map((sport) => (
                <button
                  key={sport}
                  type="button"
                  className={`chip ${selectedSports.includes(sport) ? 'chip--active' : ''}`}
                  onClick={() => toggleSport(sport)}
                >
                  {sport}
                </button>
              ))}
            </div>
          </div>

          {selectedSports.map((sport) => (
            <div key={sport} className="teams-section">
              <h3>{sport} — optional teams</h3>
              <p className="muted">Leave empty to get all games for this sport, or pick specific teams.</p>
              {teamsLoading[sport] ? (
                <div className="loader small" />
              ) : (
                <div className="team-grid">
                  {(teamsBySport[sport]?.list || []).map((team) => (
                    <label key={team} className="team-check">
                      <input
                        type="checkbox"
                        checked={(teamsBySport[sport]?.selected || []).includes(team)}
                        onChange={() => toggleTeam(sport, team)}
                      />
                      <span>{team}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}

          {error && <p className="error">{error}</p>}
          {saved && <p className="success">Preferences saved. We’ll send notifications to this number.</p>}

          <button type="submit" className="btn primary" disabled={selectedSports.length === 0}>
            Save preferences
          </button>
        </form>
      </main>

      <footer className="footer">
        <p className="muted">Notifications require SMS to be configured (e.g. Twilio). Run the schema script to create the subscriptions table.</p>
      </footer>
    </div>
  )
}

export default App
