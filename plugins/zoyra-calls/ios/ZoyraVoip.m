// Generated into ios/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/ios/.
//
// iOS requires every VoIP push to be reported to CallKit right away, from native code (JavaScript may not be
// running: the app can be launched in the background by the push). This class:
//   - sets up CallKit natively through react-native-callkeep (app name, ringtone, video support),
//   - registers for VoIP pushes (PushKit) and hands the token to react-native-voip-push-notification, which
//     forwards it to JavaScript (`register` event, cached until JS listens) → register_voip_token RPC,
//   - reports every `call` push as an incoming CallKit call (UUID = the Zoyra call id) and ends it on a
//     `call_cancel` push or when the ring times out,
//   - when the user declines on the CallKit screen while JS isn't running, tells the server directly
//     (voip-push edge function, per-call HMAC token from the push), so the caller stops ringing.
// Payload contract: supabase/functions/voip-push/index.ts.
#import "ZoyraVoip.h"

#import <CallKit/CallKit.h>
#import <PushKit/PushKit.h>
#import <UIKit/UIKit.h>

#import <RNCallKeep/RNCallKeep.h>
#import <RNVoipPushNotification/RNVoipPushNotificationManager.h>

static NSString *ZStr(id v) {
  return [v isKindOfClass:[NSString class]] && [(NSString *)v length] > 0 ? (NSString *)v : nil;
}

// react-native-callkeep endCallWithUUID reasons.
static const int ZReasonFailed = 1;
static const int ZReasonRemoteEnded = 2;
static const int ZReasonUnanswered = 3;
static const int ZReasonAnsweredElsewhere = 4;
static const int ZReasonDeclinedElsewhere = 5;

@interface ZoyraVoip () <PKPushRegistryDelegate, CXCallObserverDelegate>
@property (nonatomic, strong) PKPushRegistry *registry;
@property (nonatomic, strong) CXCallObserver *observer;
/// call id → { decline_url, decline_token } for calls reported from a push.
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *pending;
/// Calls ended by us (cancel push / timeout), so their end isn't sent to the server as a decline.
@property (nonatomic, strong) NSMutableSet<NSString *> *endedByUs;
@end

@implementation ZoyraVoip

+ (instancetype)shared {
  static ZoyraVoip *instance = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [ZoyraVoip new];
    instance.pending = [NSMutableDictionary dictionary];
    instance.endedByUs = [NSMutableSet set];
  });
  return instance;
}

+ (void)start {
  ZoyraVoip *z = [self shared];
  if (z.registry) return;

  // Native setup: CallKit is configured before any JS runs (a later RNCallKeep.setup() from JS is ignored on iOS).
  [RNCallKeep setup:@{
    @"appName": @"Zoyra",
    @"supportsVideo": @YES,
    @"maximumCallGroups": @1,
    @"maximumCallsPerCallGroup": @1,
    @"includesCallsInRecents": @NO,
    @"handleType": @"generic",
    @"ringtoneSound": @"zoyra_ring.wav",
  }];

  z.observer = [CXCallObserver new];
  [z.observer setDelegate:z queue:dispatch_get_main_queue()];

  z.registry = [[PKPushRegistry alloc] initWithQueue:dispatch_get_main_queue()];
  z.registry.delegate = z;
  z.registry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];
}

#pragma mark - PushKit

- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type {
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type {
  // The server drops tokens APNs rejects (410 / BadDeviceToken).
}

- (void)pushRegistry:(PKPushRegistry *)registry
    didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
                              forType:(PKPushType)type
                withCompletionHandler:(void (^)(void))completion {
  NSDictionary *root = payload.dictionaryPayload ?: @{};
  NSDictionary *z = [root[@"zoyra"] isKindOfClass:[NSDictionary class]] ? root[@"zoyra"] : root;

  NSString *callId = [ZStr(z[@"call_id"]) lowercaseString];
  NSUUID *uuid = callId ? [[NSUUID alloc] initWithUUIDString:callId] : nil;
  BOOL video = [ZStr(z[@"kind"]) isEqualToString:@"video"];
  NSString *name = ZStr(z[@"caller_name"]) ?: @"Zoyra";
  // Shown under the name on the CallKit screen ("mobile · Zoyra audio" in the lock screen design).
  NSString *handle = video ? @"Zoyra video" : @"Zoyra audio";

  if (!uuid) {
    // Malformed push: iOS still requires a reported call, so report and end it at once.
    [self reportAndEnd:[[NSUUID UUID].UUIDString lowercaseString] name:name handle:handle video:video reason:ZReasonFailed completion:completion];
    return;
  }

  if ([ZStr(z[@"type"]) isEqualToString:@"call_cancel"]) {
    NSString *why = ZStr(z[@"reason"]) ?: @"cancelled";
    CXCall *existing = [self callWithUUID:uuid];
    BOOL keep = [why isEqualToString:@"accepted"] && existing.hasConnected;  // answered on this device
    int reason = [why isEqualToString:@"accepted"] ? ZReasonAnsweredElsewhere
               : [why isEqualToString:@"declined"] ? ZReasonDeclinedElsewhere
               : [why isEqualToString:@"missed"] ? ZReasonUnanswered
               : ZReasonRemoteEnded;
    if (keep) {
      // Reporting the same UUID again only fails with "already exists"; it satisfies PushKit's rule.
      [self report:callId name:name handle:handle video:video payload:z completion:completion];
      return;
    }
    [self reportAndEnd:callId name:name handle:handle video:video reason:reason completion:completion];
    return;
  }

  NSString *declineUrl = ZStr(z[@"decline_url"]);
  NSString *declineToken = ZStr(z[@"decline_token"]);
  if (declineUrl && declineToken) self.pending[callId] = @{ @"url": declineUrl, @"token": declineToken };

  double expiresAt = [z[@"expires_at"] respondsToSelector:@selector(doubleValue)] ? [z[@"expires_at"] doubleValue] : 0;
  NSTimeInterval left = expiresAt > 0 ? expiresAt - [[NSDate date] timeIntervalSince1970] : 60;
  if (left <= 0) {
    // Delivered after the ring timeout: report (required) and end as unanswered.
    [self reportAndEnd:callId name:name handle:handle video:video reason:ZReasonUnanswered completion:completion];
    return;
  }

  [self report:callId name:name handle:handle video:video payload:z completion:completion];

  // Stop ringing at the server's ring timeout even if the cancel push never arrives.
  __weak ZoyraVoip *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((MIN(left, 75) + 2) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ZoyraVoip *strongSelf = weakSelf;
    if (!strongSelf) return;
    CXCall *call = [strongSelf callWithUUID:uuid];
    if (call && !call.hasEnded && !call.hasConnected) [strongSelf endCall:callId reason:ZReasonUnanswered];
  });
}

#pragma mark - CallKit

- (void)report:(NSString *)callId name:(NSString *)name handle:(NSString *)handle video:(BOOL)video payload:(NSDictionary *)payload completion:(void (^)(void))completion {
  [RNCallKeep reportNewIncomingCall:callId
                             handle:handle
                         handleType:@"generic"
                           hasVideo:video
                localizedCallerName:name
                    supportsHolding:NO
                       supportsDTMF:NO
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:payload
              withCompletionHandler:completion];
}

- (void)reportAndEnd:(NSString *)callId name:(NSString *)name handle:(NSString *)handle video:(BOOL)video reason:(int)reason completion:(void (^)(void))completion {
  __weak ZoyraVoip *weakSelf = self;
  [self report:callId name:name handle:handle video:video payload:nil completion:^{
    [weakSelf endCall:callId reason:reason];
    if (completion) completion();
  }];
}

- (void)endCall:(NSString *)callId reason:(int)reason {
  [self.endedByUs addObject:callId];
  [self.pending removeObjectForKey:callId];
  [RNCallKeep endCallWithUUID:callId reason:reason];
}

- (CXCall *)callWithUUID:(NSUUID *)uuid {
  for (CXCall *call in self.observer.calls) {
    if ([call.UUID isEqual:uuid]) return call;
  }
  return nil;
}

- (void)callObserver:(CXCallObserver *)callObserver callChanged:(CXCall *)call {
  NSString *callId = [call.UUID.UUIDString lowercaseString];
  if (call.hasConnected) {
    [self.pending removeObjectForKey:callId];
    return;
  }
  if (!call.hasEnded || call.isOutgoing) return;
  NSDictionary *decline = self.pending[callId];
  [self.pending removeObjectForKey:callId];
  if ([self.endedByUs containsObject:callId]) {
    [self.endedByUs removeObject:callId];
    return;
  }
  if (decline) [self postDecline:callId info:decline];
}

/// The user declined on the CallKit screen: tell the server (idempotent; JS also declines when it runs).
- (void)postDecline:(NSString *)callId info:(NSDictionary *)info {
  NSURL *url = [NSURL URLWithString:info[@"url"]];
  if (!url) return;
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = @"POST";
  req.timeoutInterval = 15;
  [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  req.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{ @"action": @"decline", @"call_id": callId, @"token": info[@"token"] } options:0 error:nil];

  UIApplication *app = [UIApplication sharedApplication];
  __block UIBackgroundTaskIdentifier task = [app beginBackgroundTaskWithName:@"ZoyraDecline" expirationHandler:^{
    [app endBackgroundTask:task];
    task = UIBackgroundTaskInvalid;
  }];
  [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (task != UIBackgroundTaskInvalid) {
        [app endBackgroundTask:task];
        task = UIBackgroundTaskInvalid;
      }
    });
  }] resume];
}

@end
