import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, MapPin, ShieldCheck, UserRound } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../auth/auth-context.jsx';
import { api } from '../lib/api.js';
import { BrandMark } from '../components/brand-mark.jsx';
import { Alert, AlertDescription } from '../components/ui/alert.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardDescription, CardTitle } from '../components/ui/card.jsx';
import { Field, Label } from '../components/ui/field.jsx';
import { Input } from '../components/ui/input.jsx';

// ---------------------------------------------------------------------------
// OTP input — 6 individual boxes, auto-advance, backspace support, paste
// ---------------------------------------------------------------------------
const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;
const PENDING_EMAIL_KEY = 'seatspot.pendingEmail';

function OtpInput({ value, onChange }) {
  const refs = useRef([]);
  const digits = value.split('').concat(Array(OTP_LENGTH).fill('')).slice(0, OTP_LENGTH);

  function handleKeyDown(index, event) {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next = value.slice(0, index) + '' + value.slice(index + 1);
      onChange(next.replace(/[^0-9]/g, ''));
      if (index > 0) refs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      refs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      refs.current[index + 1]?.focus();
    }
  }

  function handleChange(index, event) {
    const digit = event.target.value.replace(/[^0-9]/g, '').slice(-1);
    const next = value.split('');
    next[index] = digit;
    const combined = next.join('').replace(/[^0-9]/g, '').slice(0, OTP_LENGTH);
    onChange(combined);
    if (digit && index < OTP_LENGTH - 1) {
      refs.current[index + 1]?.focus();
    }
  }

  function handlePaste(event) {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, OTP_LENGTH);
    onChange(pasted);
    const focusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
    refs.current[focusIndex]?.focus();
  }

  return (
    <div className="otp-boxes" role="group" aria-label="Six-digit verification code">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => { refs.current[index] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          pattern="[0-9]"
          maxLength={1}
          value={digit}
          className="otp-box"
          aria-label={`Digit ${index + 1}`}
          onChange={(e) => handleChange(index, e)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={index === 0 ? handlePaste : undefined}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

function ResendCountdown({ onResend, busy, initialSeconds = RESEND_COOLDOWN_SECONDS }) {
  const [seconds, setSeconds] = useState(initialSeconds);
  const canResend = seconds === 0;

  useEffect(() => {
    setSeconds(initialSeconds);
  }, [initialSeconds]);

  useEffect(() => {
    if (seconds <= 0) return undefined;
    const interval = setInterval(() => {
      setSeconds((prev) => {
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds <= 0]);

  return (
    <div className="resend-row">
      {canResend ? (
        <button
          className="resend-link"
          type="button"
          disabled={busy}
          onClick={onResend}
        >
          Send a new code
        </button>
      ) : (
        <span className="resend-timer">
          Resend available in <strong>{seconds}s</strong>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuthPage
// ---------------------------------------------------------------------------
function readPendingEmail() {
  try {
    return localStorage.getItem(PENDING_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function AuthPage() {
  const [searchParams] = useSearchParams();
  const [storedPendingEmail] = useState(readPendingEmail);
  const [mode, setMode] = useState(storedPendingEmail ? 'verify' : 'login');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [pendingEmail, setPendingEmail] = useState(storedPendingEmail);
  const [otpValue, setOtpValue] = useState('');
  const [restaurantId, setRestaurantId] = useState('');
  const [formError, setFormError] = useState('');
  const [resendKey, setResendKey] = useState(0); // bump to reset countdown
  // When resuming a pending verification after a reload, let the user request a
  // code immediately — the server still enforces the real cooldown.
  const [resendSeconds, setResendSeconds] = useState(storedPendingEmail ? 0 : RESEND_COOLDOWN_SECONDS);
  const { saveToken } = useAuth();
  const navigate = useNavigate();
  const expired = searchParams.get('reason') === 'expired';

  function rememberPendingEmail(value) {
    const nextEmail = String(value ?? '').trim().toLowerCase();
    try {
      localStorage.setItem(PENDING_EMAIL_KEY, nextEmail);
    } catch {
      // ignore storage failures (private mode etc.)
    }
    setPendingEmail(nextEmail);
    setEmail(nextEmail);
    setOtpValue('');
    setResendKey((key) => key + 1);
    setMode('verify');
  }

  function clearPendingEmail() {
    try {
      localStorage.removeItem(PENDING_EMAIL_KEY);
    } catch {
      // ignore
    }
    setPendingEmail('');
  }

  function startVerification(value, { seconds = 0, message = '' } = {}) {
    rememberPendingEmail(value);
    setResendSeconds(seconds);
    setFormError(message);
  }

  // Classify backend OTP errors for the user
  function otpErrorMessage(error) {
    if (error.status === 429) return 'Too many attempts. Wait before trying again.';
    if (/locked|maximum|too many/i.test(error.message)) return 'This code is locked after too many wrong attempts. Request a new one.';
    if (/expired/i.test(error.message)) return 'The code has expired. Request a new one below.';
    if (/invalid/i.test(error.message)) return 'That code is incorrect. Check your email and try again.';
    return error.message;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setFormError('');
    const data = new FormData(event.currentTarget);

    try {
      if (mode === 'signup') {
        const signupEmail = String(data.get('email') ?? '').trim().toLowerCase();
        const signupResult = await api('/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ name: data.get('name'), email: signupEmail, password: data.get('password') })
        });
        startVerification(signupEmail, { seconds: RESEND_COOLDOWN_SECONDS });
        if (signupResult?.emailDispatched === false) {
          toast.error('Account created but verification email could not be sent', {
            description: 'Use "Send a new code" below, or check the server logs.'
          });
        } else {
          toast.success('Account created. Check your email for the verification code.');
        }
      } else if (mode === 'verify') {
        const result = await api('/auth/verify-otp', {
          method: 'POST',
          body: JSON.stringify({ email: pendingEmail, otp: otpValue })
        });
        clearPendingEmail();
        finishLogin(result.token);
      } else {
        const credentials = { email: data.get('email'), password: data.get('password') };
        if (restaurantId.trim()) credentials.restaurantId = restaurantId.trim();
        const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
        clearPendingEmail();
        finishLogin(result.token);
      }
    } catch (error) {
      if (error.status === 409 && error.payload?.code === 'EMAIL_UNVERIFIED') {
        startVerification(data.get('email'), {
          seconds: 0,
          message: 'This email is already registered but not verified. Send a new code to finish signing up.'
        });
        toast.info('Verify your email', {
          description: 'Send a new code to finish signing up.'
        });
      } else {
        const message = mode === 'verify'
          ? otpErrorMessage(error)
          : error.status === 429
            ? 'Too many attempts. Wait a moment and try again.'
            : error.status === 401
              ? 'Email or password is incorrect.'
              : error.message;
        setFormError(message);
        toast.error(mode === 'verify' ? 'Verification failed' : error.status === 429 ? 'Rate limit reached' : 'Could not continue', { description: message });
      }
    } finally {
      setBusy(false);
    }
  }

  function finishLogin(token) {
    saveToken(token);
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    toast.success('Signed in');
    navigate(claims.role === 'staff' ? `/staff/${claims.restaurantId}` : '/restaurants', { replace: true });
  }

  const resendOtp = useCallback(async () => {
    setBusy(true);
    setFormError('');
    try {
      await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email: pendingEmail }) });
      setOtpValue('');
      setResendKey((k) => k + 1); // reset countdown
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
      toast.success('A new code has been sent to your email.');
    } catch (error) {
      if (error.status === 429) {
        const retryAfterSeconds = error.payload?.retryAfterSeconds ?? error.retryAfterSeconds ?? 60;
        setResendSeconds(Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) : 60);
        setResendKey((k) => k + 1);
        const message = error.payload?.error ?? error.message ?? 'Please wait before requesting another code.';
        setFormError(message);
        toast.error('Could not resend', { description: message });
      } else {
        const message = 'Could not send a new code. Please try again.';
        setFormError(message);
        toast.error('Could not resend', { description: message });
      }
    } finally {
      setBusy(false);
    }
  }, [pendingEmail]);

  const isSignup = mode === 'signup';

  return <main className="auth-screen">
    <div className="auth-frame">
      <section className="auth-aside">
        <header className="flex items-center justify-between"><BrandMark /><span className="text-xs font-semibold uppercase tracking-[0.12em] text-white/55">Restaurant operations</span></header>
        <div className="auth-aside-content">
          <div className="aside-kicker"><span className="live-dot" /> Live service</div>
          <h1>Make room<br />for a good night.</h1>
          <p>Find a table, keep your place, and let the team take it from there.</p>
          <div className="service-preview">
            <div className="flex items-center justify-between">
              <div><div className="preview-label">Tonight · Chennai</div><div className="preview-title">The Garden Table</div></div>
              <span className="preview-count">04<span> open</span></span>
            </div>
            <div className="preview-tables" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <i className={index < 4 ? 'is-open' : ''} key={index} />)}</div>
            <div className="flex items-center justify-between preview-foot"><span><MapPin size={13} /> Ramapuram</span><span>Updated just now</span></div>
          </div>
        </div>
        <footer className="auth-aside-foot"><span>SEATSPOT / 01</span><span>Made for the moments around the table</span></footer>
      </section>

      <section className="auth-main">
        <div className="auth-mobile-brand"><BrandMark /></div>
        <div className="auth-card">
          <header className="space-y-2 pb-7">
            <div className="auth-icon"><ShieldCheck size={20} /></div>
            <p className="eyebrow">{mode === 'verify' ? 'Verify your email' : isSignup ? 'Create your account' : 'Welcome back'}</p>
            <CardTitle className="font-display text-[27px]">{mode === 'verify' ? 'One quick check.' : isSignup ? 'Save your seat.' : 'Good to see you.'}</CardTitle>
            <CardDescription className="mt-2 leading-6">{mode === 'verify' ? `Enter the 6-digit code sent to ${pendingEmail}.` : isSignup ? 'A table is better when the details are handled.' : 'Sign in to see what is available tonight.'}</CardDescription>
          </header>

          {expired && <Alert variant="destructive" className="mb-5"><AlertDescription>Your session expired. Sign in again to continue.</AlertDescription></Alert>}
          {formError && <Alert variant="destructive" className="mb-5"><AlertDescription>{formError}</AlertDescription></Alert>}

          <form onSubmit={handleSubmit} className="grid gap-4">
            {mode === 'signup' && <Field><Label htmlFor="name">Full name</Label><div className="input-icon-wrap"><UserRound size={16} /><Input id="name" name="name" autoComplete="name" placeholder="Alex Morgan" required minLength={2} /></div></Field>}
            {mode !== 'verify' && <Field><Label htmlFor="email">Email address</Label><Input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>}
            {mode === 'login' && <Field><Label htmlFor="restaurantId">Restaurant ID <span className="font-normal text-muted-foreground">· staff only</span></Label><Input id="restaurantId" value={restaurantId} onChange={(event) => setRestaurantId(event.target.value)} placeholder="Leave blank for guest access" autoComplete="off" /></Field>}
            {mode === 'signup' && <Field><Label htmlFor="password">Password</Label><div className="password-wrap"><Input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="At least 8 characters" minLength={8} required /><Button type="button" variant="ghost" size="icon" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</Button></div></Field>}
            {mode === 'login' && <Field><div className="flex items-center justify-between"><Label htmlFor="password">Password</Label><KeyRound size={15} className="text-muted-foreground" /></div><div className="password-wrap"><Input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" required /><Button type="button" variant="ghost" size="icon" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</Button></div></Field>}
            {mode === 'verify' && <>
              <Field>
                <Label>Verification code</Label>
                <OtpInput value={otpValue} onChange={setOtpValue} />
              </Field>
              <ResendCountdown key={resendKey} onResend={resendOtp} busy={busy} initialSeconds={resendSeconds} />
            </>}
            <Button className="mt-2 w-full" size="lg" disabled={busy || (mode === 'verify' && otpValue.length < OTP_LENGTH)} type="submit">
              {busy ? 'Please wait…' : mode === 'verify' ? 'Verify and continue' : isSignup ? 'Create account' : 'Sign in'} {!busy && <ArrowRight size={17} />}
            </Button>
          </form>

          <div className="auth-switch">
            {mode === 'verify' ? <>
              <button type="button" onClick={() => { clearPendingEmail(); setFormError(''); setResendSeconds(0); setMode('signup'); }}><ArrowLeft size={14} /> Back to sign up</button>
              <button type="button" onClick={() => { clearPendingEmail(); setFormError(''); setResendSeconds(0); setMode('login'); }}>Back to sign in</button>
            </> : <>
              <span>{isSignup ? 'Already have an account?' : 'New to SeatSpot?'}</span>
              <button type="button" onClick={() => { clearPendingEmail(); setFormError(''); setMode(isSignup ? 'login' : 'signup'); }}>{isSignup ? 'Sign in' : 'Create account'}</button>
            </>}
          </div>
        </div>
        <p className="auth-legal">By continuing, you agree to SeatSpot's <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</p>
      </section>
    </div>
  </main>;
}