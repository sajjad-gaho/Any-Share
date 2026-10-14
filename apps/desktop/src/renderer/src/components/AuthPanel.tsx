import { zodResolver } from '@hookform/resolvers/zod';
import {
  loginInputSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerInputSchema,
  signupVerifySchema,
  type LoginInput,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
  type RegisterInput,
  type SignupVerifyInput,
} from '@remote-desktop/shared';
import { Button, FieldError, Input, Label } from '@remote-desktop/ui';
import { useId, useState, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormRegister } from 'react-hook-form';
import { useAuthStore } from '@/stores/auth-store';

type Mode = 'sign-in' | 'register' | 'register-confirm' | 'reset-request' | 'reset-confirm';

function Field<T extends FieldValues>({
  name,
  label,
  type = 'text',
  autoComplete,
  register,
  error,
}: {
  name: Path<T>;
  label: string;
  type?: string;
  autoComplete?: string;
  register: UseFormRegister<T>;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        className="max-w-sm"
        aria-invalid={Boolean(error)}
        {...register(name)}
      />
      <FieldError>{error}</FieldError>
    </div>
  );
}

function FormShell({
  onSubmit,
  submitting,
  submitLabel,
  message,
  children,
  footer,
}: {
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
  message: { tone: 'error' | 'info'; text: string } | null;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {children}
      <p
        role={message?.tone === 'error' ? 'alert' : 'status'}
        className={
          message?.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
        }
      >
        {message?.text ?? ''}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Please wait…' : submitLabel}
        </Button>
        {footer}
      </div>
    </form>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm font-medium underline underline-offset-4 hover:text-foreground text-muted-foreground"
    >
      {children}
    </button>
  );
}

type Message = { tone: 'error' | 'info'; text: string } | null;

function SignInForm({
  onMode,
  onConfirm,
}: {
  onMode: (mode: Mode) => void;
  onConfirm: (email: string) => void;
}) {
  const login = useAuthStore((s) => s.login);
  const [message, setMessage] = useState<Message>(null);
  const { register, handleSubmit, formState } = useForm<LoginInput>({
    resolver: zodResolver(loginInputSchema),
    defaultValues: { email: '', password: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    setMessage(null);
    const result = await login(values);
    if (result.ok) return;
    // Signed up but never entered the emailed code: go straight to that step.
    if (result.error.code === 'email_not_confirmed') onConfirm(values.email);
    else setMessage({ tone: 'error', text: result.error.message });
  });
  return (
    <FormShell
      onSubmit={onSubmit}
      submitting={formState.isSubmitting}
      submitLabel="Sign in"
      message={message}
      footer={
        <>
          <LinkButton onClick={() => onMode('register')}>Create an account</LinkButton>
          <LinkButton onClick={() => onMode('reset-request')}>Forgot password?</LinkButton>
        </>
      }
    >
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        register={register}
        error={formState.errors.email?.message}
      />
      <Field
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        register={register}
        error={formState.errors.password?.message}
      />
    </FormShell>
  );
}

function RegisterForm({
  onMode,
  onConfirm,
}: {
  onMode: (mode: Mode) => void;
  onConfirm: (email: string) => void;
}) {
  const registerAccount = useAuthStore((s) => s.register);
  const [message, setMessage] = useState<Message>(null);
  const { register, handleSubmit, formState } = useForm<RegisterInput>({
    resolver: zodResolver(registerInputSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    setMessage(null);
    const result = await registerAccount(values);
    if (!result.ok) setMessage({ tone: 'error', text: result.error.message });
    else if (result.value.needsConfirmation) onConfirm(values.email);
  });
  return (
    <FormShell
      onSubmit={onSubmit}
      submitting={formState.isSubmitting}
      submitLabel="Create account"
      message={message}
      footer={<LinkButton onClick={() => onMode('sign-in')}>I already have an account</LinkButton>}
    >
      <Field
        name="displayName"
        label="Display name"
        autoComplete="name"
        register={register}
        error={formState.errors.displayName?.message}
      />
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        register={register}
        error={formState.errors.email?.message}
      />
      <Field
        name="password"
        label="Password (10+ characters)"
        type="password"
        autoComplete="new-password"
        register={register}
        error={formState.errors.password?.message}
      />
    </FormShell>
  );
}

function ResetRequestForm({
  onMode,
  onSent,
}: {
  onMode: (mode: Mode) => void;
  onSent: (email: string) => void;
}) {
  const request = useAuthStore((s) => s.requestPasswordReset);
  const [message, setMessage] = useState<Message>(null);
  const { register, handleSubmit, formState } = useForm<PasswordResetRequestInput>({
    resolver: zodResolver(passwordResetRequestSchema),
    defaultValues: { email: '' },
  });
  const onSubmit = handleSubmit(async ({ email }) => {
    setMessage(null);
    const result = await request(email);
    if (!result.ok) setMessage({ tone: 'error', text: result.error.message });
    else onSent(email);
  });
  return (
    <FormShell
      onSubmit={onSubmit}
      submitting={formState.isSubmitting}
      submitLabel="Email me a code"
      message={message}
      footer={<LinkButton onClick={() => onMode('sign-in')}>Back to sign in</LinkButton>}
    >
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        register={register}
        error={formState.errors.email?.message}
      />
    </FormShell>
  );
}

function ResetConfirmForm({ email, onMode }: { email: string; onMode: (mode: Mode) => void }) {
  const confirm = useAuthStore((s) => s.confirmPasswordReset);
  const [message, setMessage] = useState<Message>({
    tone: 'info',
    text: 'If that address has an account, we sent it a code.',
  });
  const { register, handleSubmit, formState } = useForm<PasswordResetConfirmInput>({
    resolver: zodResolver(passwordResetConfirmSchema),
    defaultValues: { email, code: '', newPassword: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    setMessage(null);
    const result = await confirm(values);
    if (!result.ok) setMessage({ tone: 'error', text: result.error.message });
    else onMode('sign-in');
  });
  return (
    <FormShell
      onSubmit={onSubmit}
      submitting={formState.isSubmitting}
      submitLabel="Set new password"
      message={message}
      footer={<LinkButton onClick={() => onMode('sign-in')}>Back to sign in</LinkButton>}
    >
      <Field
        name="code"
        label="Code from the email"
        autoComplete="one-time-code"
        register={register}
        error={formState.errors.code?.message}
      />
      <Field
        name="newPassword"
        label="New password (10+ characters)"
        type="password"
        autoComplete="new-password"
        register={register}
        error={formState.errors.newPassword?.message}
      />
    </FormShell>
  );
}

function SignupConfirmForm({ email, onMode }: { email: string; onMode: (mode: Mode) => void }) {
  const verify = useAuthStore((s) => s.verifySignup);
  const resend = useAuthStore((s) => s.resendSignup);
  const [message, setMessage] = useState<Message>({
    tone: 'info',
    text: `We emailed a code to ${email}. Enter it to finish creating your account.`,
  });
  const [resending, setResending] = useState(false);
  const { register, handleSubmit, formState } = useForm<SignupVerifyInput>({
    resolver: zodResolver(signupVerifySchema),
    defaultValues: { email, code: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    setMessage(null);
    const result = await verify(values);
    // On success the auth store switches to signed-in and this panel goes away.
    if (!result.ok) setMessage({ tone: 'error', text: result.error.message });
  });
  const sendAgain = async () => {
    setResending(true);
    const result = await resend(email);
    setResending(false);
    setMessage(
      result.ok
        ? { tone: 'info', text: 'If the account still needs confirming, a new code is on its way.' }
        : { tone: 'error', text: result.error.message },
    );
  };
  return (
    <FormShell
      onSubmit={onSubmit}
      submitting={formState.isSubmitting}
      submitLabel="Confirm and sign in"
      message={message}
      footer={
        <>
          <LinkButton onClick={() => void sendAgain()}>
            {resending ? 'Sending…' : 'Send a new code'}
          </LinkButton>
          <LinkButton onClick={() => onMode('sign-in')}>Back to sign in</LinkButton>
        </>
      }
    >
      <Field
        name="code"
        label="Code from the email"
        autoComplete="one-time-code"
        register={register}
        error={formState.errors.code?.message}
      />
    </FormShell>
  );
}

/** Sign in, create an account, or reset a password. Credentials go straight to the main process. */
export function AuthPanel() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [resetEmail, setResetEmail] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const confirm = (email: string) => {
    setSignupEmail(email);
    setMode('register-confirm');
  };
  switch (mode) {
    case 'register':
      return <RegisterForm onMode={setMode} onConfirm={confirm} />;
    case 'register-confirm':
      return <SignupConfirmForm email={signupEmail} onMode={setMode} />;
    case 'reset-request':
      return (
        <ResetRequestForm
          onMode={setMode}
          onSent={(email) => {
            setResetEmail(email);
            setMode('reset-confirm');
          }}
        />
      );
    case 'reset-confirm':
      return <ResetConfirmForm email={resetEmail} onMode={setMode} />;
    default:
      return <SignInForm onMode={setMode} onConfirm={confirm} />;
  }
}
