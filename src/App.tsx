import { useEffect, useState } from "react"
import EnquiryModal from "./components/EnquiryModal"
import PrivacyNoticeModal from "./components/PrivacyNoticeModal"
import AdminDashboard from "./components/AdminDashboard"
import { EnquiryType, InstrumentType } from "./lib/types"
import { appConfig } from "./lib/config"
import { initialAuthCallback } from "./lib/supabase"

const lessons = [
  {
    number: "01",
    instrumentId: "piano" as InstrumentType,
    kicker: "THE CLASSIC BEGINNING",
    title: "Piano",
    description:
      "Explore melody and harmony at the keys, building a strong musical foundation. Online and in-person classes are available.",
    image:
      "https://images.unsplash.com/photo-1590581296894-3c897baa0e54?auto=format&fit=crop&w=900&q=80",
    alt: "An early-teen student playing the piano",
  },
  {
    number: "02",
    instrumentId: "keyboard" as InstrumentType,
    kicker: "MUSIC AT YOUR FINGERTIPS",
    title: "Keyboard",
    description:
      "Start exploring music with an approachable instrument shaped around your pace. Online and in-person classes are available.",
    image:
      "https://images.unsplash.com/photo-1530799712133-ed7ded30dd8c?auto=format&fit=crop&w=900&q=80",
    alt: "An adult musician playing an electronic keyboard",
  },
  {
    number: "03",
    instrumentId: "violin" as InstrumentType,
    kicker: "A VOICE OF ITS OWN",
    title: "Violin",
    description:
      "Learn to shape a beautiful sound with focus, technique, and expression bow by bow. Online and in-person classes are available.",
    image:
      "https://images.unsplash.com/photo-1566913485242-694e995731b4?auto=format&fit=crop&w=900&q=80",
    alt: "A young musician playing the violin",
  },
]

const approachPoints = [
  ["Personal guidance", "Lessons meet each student where they are."],
  ["Strong foundations", "Build musical skills that last a lifetime."],
  ["Joy in the process", "Make space for curiosity and expression."],
]

function Brand({ footer = false }: { footer?: boolean }) {
  return (
    <a
      className={`brand${footer ? " footer-brand" : ""}`}
      href="#home"
      aria-label="Mozart School home"
    >
      <span className="brand-mark" aria-hidden="true">
        M
      </span>
      <span>
        MOZART SCHOOL
        <small>OF WESTERN CLASSICAL MUSIC</small>
      </span>
    </a>
  )
}

// Development-only demo indicator: data stays in this browser.
function DemoModeBanner() {
  if (appConfig.mode !== "mock") return null
  return (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-40 max-w-xs bg-black text-white text-[11px] leading-snug px-3 py-2 shadow-lg"
    >
      <strong className="uppercase tracking-wider">Demo mode</strong> — enquiries and staff data are stored only in
      this browser and are not sent to the school.
    </div>
  )
}

// /admin, #admin, or an auth email link (which may land on the site root when
// Supabase falls back to the Site URL).
function isAdminLocation(): boolean {
  return (
    window.location.pathname.startsWith("/admin") ||
    window.location.hash === "#admin" ||
    initialAuthCallback.kind !== "none"
  )
}

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false)

  // Route state for private admin dashboard (/admin or #admin)
  const [isAdminRoute, setIsAdminRoute] = useState(() => typeof window !== "undefined" && isAdminLocation())

  // Enquiry modal state
  const [enquiryModalOpen, setEnquiryModalOpen] = useState(false)
  const [enquiryType, setEnquiryType] = useState<EnquiryType>("lesson")
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentType>("piano")
  const [enquirySource, setEnquirySource] = useState("hero_cta")

  // Privacy notice modal state
  const [privacyModalOpen, setPrivacyModalOpen] = useState(false)

  useEffect(() => {
    document.body.classList.toggle("menu-is-open", menuOpen)
    return () => document.body.classList.remove("menu-is-open")
  }, [menuOpen])

  // Listen for hash/popstate changes for admin route
  useEffect(() => {
    const handleRouteChange = () => {
      setIsAdminRoute(window.location.pathname.startsWith("/admin") || window.location.hash === "#admin")
    }
    window.addEventListener("hashchange", handleRouteChange)
    window.addEventListener("popstate", handleRouteChange)
    return () => {
      window.removeEventListener("hashchange", handleRouteChange)
      window.removeEventListener("popstate", handleRouteChange)
    }
  }, [])

  const closeMenu = () => setMenuOpen(false)

  // Modal open helpers
  const openLessonEnquiry = (inst: InstrumentType = "piano", source: string = "button") => {
    setSelectedInstrument(inst)
    setEnquiryType("lesson")
    setEnquirySource(source)
    setEnquiryModalOpen(true)
    closeMenu()
  }

  const openLocationInterest = (source: string = "location_cta") => {
    setEnquiryType("location_interest")
    setEnquirySource(source)
    setEnquiryModalOpen(true)
    closeMenu()
  }

  const openGeneralContact = (source: string = "contact_cta") => {
    setEnquiryType("general")
    setEnquirySource(source)
    setEnquiryModalOpen(true)
    closeMenu()
  }

  // If user navigated to /admin or #admin, render the protected admin area
  if (isAdminRoute) {
    return (
      <>
      <DemoModeBanner />
      <AdminDashboard
        onExit={() => {
          if (window.location.hash === "#admin") {
            window.location.hash = ""
          }
          if (window.location.pathname.startsWith("/admin")) {
            window.history.pushState(null, "", "/")
          }
          setIsAdminRoute(false)
        }}
      />
      </>
    )
  }

  return (
    <>
      <DemoModeBanner />
      <header className="site-header">
        <Brand />
        <button
          className={`menu-toggle${menuOpen ? " is-open" : ""}`}
          type="button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="site-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
        </button>
        <nav
          className={`nav${menuOpen ? " open" : ""}`}
          id="site-navigation"
          aria-label="Primary navigation"
        >
          <a href="#about" onClick={closeMenu}>
            Our school
          </a>
          <a href="#courses" onClick={closeMenu}>
            Lessons
          </a>
          <a href="#stories" onClick={closeMenu}>
            Student stories
          </a>
          <a href="#contact" onClick={closeMenu}>
            Visit us
          </a>
          <button
            type="button"
            className="nav-cta"
            onClick={() => openLessonEnquiry("piano", "header_nav")}
          >
            Enquire now <span aria-hidden="true">↗</span>
          </button>
        </nav>
      </header>

      <main>
        <section className="hero" id="home">
          <div className="hero-copy">
            <p className="eyebrow">
              <span /> MUSIC FOR EVERY BEGINNING
            </p>
            <h1>
              Discover the music
              <br />
              you can <em>make.</em>
            </h1>
            <p className="lead">
              Learn Piano, Keyboard, or Violin online or in person—at a pace that feels right for you.
            </p>
            <div className="hero-actions">
              <a className="button dark" href="#courses">
                Explore our lessons <span aria-hidden="true">↗</span>
              </a>
              <a className="text-link" href="#contact">
                Come visit us <span aria-hidden="true">→</span>
              </a>
            </div>
            <div className="hero-note">
              <span className="note-icon" aria-hidden="true">
                ♪
              </span>
              <span>
                Online and in-person classes are available.
                <br />
                <b>Children · Teens · Adults</b>
              </span>
            </div>
          </div>

          <div className="hero-visual">
            <img
              src="https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?auto=format&fit=crop&w=1300&q=85"
              alt="Sunlight falling across a grand piano"
            />
            <div className="photo-caption">
              <span>01 / THE FIRST NOTE</span>
              <span>Music begins with a moment.</span>
            </div>
            <div className="round-seal" aria-hidden="true">
              LEARN
              <br />
              LISTEN
              <br />
              GROW
              <span>✳</span>
            </div>
          </div>

          <div className="hero-foot">
            <span>ONLINE & IN-PERSON CLASSES</span>
            <span>COMING SOON — A WELCOMING NEW SPACE IS ON THE WAY</span>
            <span>SCROLL TO DISCOVER ↓</span>
          </div>
        </section>

        <section className="intro section-pad" id="about">
          <div className="section-label">01 — A PLACE TO BEGIN</div>
          <div className="intro-grid">
            <h2>
              Every musician
              <br />
              starts <em>somewhere.</em>
            </h2>
            <div>
              <p className="intro-text">
                At Mozart School, the first lesson is an invitation: to listen
                closely, try something new, and find joy in the sound you make.
              </p>
              <p>
                Online and in-person classes are available. With patient guidance and a love for Western classical music, we
                help each student build confidence at their own pace—whether
                they are playing their very first note or ready for the next
                challenge.
              </p>
              <button
                type="button"
                className="under-link"
                onClick={() => openLessonEnquiry("piano", "intro_section")}
              >
                Get to know our school <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
        </section>

        <section className="instruments section-pad" id="courses">
          <div className="section-top">
            <div>
              <div className="section-label">02 — FIND YOUR INSTRUMENT</div>
              <h2>
                Three ways to
                <br />
                <em>find your music.</em>
              </h2>
            </div>
            <p>
              Online and in-person classes are available. Good learning begins with curiosity—choose the sound that speaks to you.
            </p>
          </div>
          <div className="instrument-grid">
            {lessons.map((lesson) => (
              <article className="instrument-card" key={lesson.title}>
                <div className="card-image">
                  <img src={lesson.image} alt={lesson.alt} />
                  <span>{lesson.number}</span>
                </div>
                <div className="card-copy">
                  <div className="card-kicker">{lesson.kicker}</div>
                  <h3>{lesson.title}</h3>
                  <p>{lesson.description}</p>
                  <button
                    type="button"
                    onClick={() => openLessonEnquiry(lesson.instrumentId, `${lesson.instrumentId}_card`)}
                    className="instrument-enquire-link"
                  >
                    Discover {lesson.title.toLowerCase()}{" "}
                    <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="approach">
          <div className="approach-image">
            <img
              src="https://images.unsplash.com/photo-1507838153414-b4b713384a76?auto=format&fit=crop&w=1200&q=85"
              alt="A young musician practising piano"
            />
          </div>
          <div className="approach-copy">
            <div className="section-label">03 — OUR APPROACH</div>
            <h2>
              Progress, with
              <br />
              <em>room to breathe.</em>
            </h2>
            <p>
              Learning music is a journey made of small discoveries. Our
              teaching brings together careful technique, musical understanding
              and the encouragement to keep going.
            </p>
            <div className="approach-points">
              {approachPoints.map(([title, detail], index) => (
                <div key={title}>
                  <span>0{index + 1}</span>
                  <p>
                    <b>{title}</b>
                    <br />
                    {detail}
                  </p>
                </div>
              ))}
            </div>
            <a className="under-link" href="#about">
              More about how we teach <span aria-hidden="true">↗</span>
            </a>
          </div>
        </section>

        <section className="stories section-pad" id="stories">
          <div className="section-label">04 — NOTES FROM OUR COMMUNITY</div>
          <div className="story-grid">
            <div>
              <h2>
                Small steps.
                <br />
                <em>Beautiful progress.</em>
              </h2>
              <p className="story-intro">
                Every student has a story worth celebrating. Here are a few
                moments from the musical journeys growing at our school.
              </p>
              <button
                type="button"
                className="under-link"
                onClick={() => openLessonEnquiry("piano", "stories_section")}
              >
                Start your own story <span aria-hidden="true">↗</span>
              </button>
            </div>
            <div className="quote-card">
              <span className="quote-mark" aria-hidden="true">
                “
              </span>
              <blockquote>
                Our child looks forward to every lesson. It has been wonderful
                to see their confidence grow along with their music.
              </blockquote>
              <div className="quote-by">
                <span className="avatar" aria-hidden="true">
                  P
                </span>
                <span>
                  <b>Parent of a student</b>
                  <small>STUDENT FAMILY · PIANO</small>
                </span>
              </div>
              <div className="quote-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        </section>

        {/* Visit Section with quote preserved */}
        <section className="visit" id="contact">
          <div className="visit-art">
            <div className="visit-circle-wrap">
              <span className="orbit-one" aria-hidden="true" />
              <span className="orbit-two" aria-hidden="true" />
              <div className="visit-art-content">
                <svg
                  className="visit-note-icon"
                  width="54"
                  height="82"
                  viewBox="0 0 54 82"
                  fill="currentColor"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path d="M19 81.5C8.8 81.5 1.5 74.8 1.5 66.8C1.5 58.7 9.2 52.5 20.2 52.5C26.8 52.5 32 55.4 35 60V9C35 7.2 36.4 5.8 38.2 5.8C39.5 5.8 48.5 10.2 51.5 23.2C52.5 28 48.8 32 45.2 29.2C42.5 27 40 22.4 40 16.2V66.2C37.8 75 29.5 81.5 19 81.5Z" />
                </svg>
                <p className="visit-quote">“Come as you are.”</p>
              </div>
            </div>
          </div>
          <div className="visit-copy">
            <div className="section-label">05 — YOUR NEXT NOTE STARTS HERE</div>
            <h2>
              Ready to find
              <br />
              <em>your first note?</em>
            </h2>
            <p>
              Online and in-person classes are available. Tell us a little about who’s learning and which instrument has
              caught your ear. We’ll help you take the next step.
            </p>
            <button
              type="button"
              className="button cream visit-action-btn"
              onClick={() => openLessonEnquiry("piano", "visit_section")}
            >
              Make a lesson enquiry <span aria-hidden="true">↗</span>
            </button>
          </div>
        </section>

        {/* Contact details section: Unconfirmed location, clickable phone & email, general contact form */}
        <section className="contact-details section-pad">
          <div>
            <div className="section-label">COME SAY HELLO</div>
            <h3>
              There’s a seat
              <br />
              waiting for you.
            </h3>
          </div>
          <div className="detail">
            <span>CLASS LOCATION</span>
            <p>
              Online and in-person classes are available.
              <br />
              <strong>Coming soon — A welcoming new space is on the way.</strong>
            </p>
            <p style={{ fontSize: "13.5px", lineHeight: "1.6", color: "var(--muted)", margin: "0 0 16px" }}>
              In-person classes are coming soon — A welcoming new space is on the way. Register your interest and we’ll keep you informed.
            </p>
            <button
              type="button"
              onClick={() => openLocationInterest("location_detail_card")}
              className="detail-action-link"
            >
              Register your interest ↗
            </button>
          </div>
          <div className="detail">
            <span>GET IN TOUCH</span>
            <p>
              <a href="tel:9043877104" className="contact-tel-link">
                9043877104
              </a>
              <br />
              <a href="mailto:srinivaschetty@gmail.com" className="contact-mail-link">
                srinivaschetty@gmail.com
              </a>
            </p>
            <button
              type="button"
              onClick={() => openGeneralContact("contact_detail_card")}
              className="detail-action-link"
            >
              Send us a note ↗
            </button>
          </div>
        </section>
      </main>

      <footer>
        <Brand footer />
        <p>Every note has a beginning.</p>
        <div className="footer-meta">
          <button
            type="button"
            onClick={() => setPrivacyModalOpen(true)}
            className="footer-text-btn"
          >
            Privacy Notice
          </button>
          <span className="footer-sep">·</span>
          <a
            href="#admin"
            onClick={() => setIsAdminRoute(true)}
            className="footer-text-btn"
          >
            Staff Admin
          </a>
        </div>
        <span>© {new Date().getFullYear()} MOZART SCHOOL</span>
      </footer>

      {/* Interactive Modals */}
      <EnquiryModal
        isOpen={enquiryModalOpen}
        onClose={() => setEnquiryModalOpen(false)}
        initialType={enquiryType}
        initialInstrument={selectedInstrument}
        source={enquirySource}
      />

      <PrivacyNoticeModal
        isOpen={privacyModalOpen}
        onClose={() => setPrivacyModalOpen(false)}
      />
    </>
  )
}
