// Generated into ios/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/ios/.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// PushKit (VoIP push) → CallKit, natively, so a call rings even when the app was killed and
/// JavaScript isn't running. Started from AppDelegate.application(_:didFinishLaunchingWithOptions:).
@interface ZoyraVoip : NSObject
+ (void)start;
@end

NS_ASSUME_NONNULL_END
